import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("exits naturally after closing a bundled audio and data-channel session", async () => {
  // A runner can hide leaked handles. Test shutdown in a separate process instead.
  const require = createRequire(import.meta.url);
  const werift = new URL("../../index.mjs", pathToFileURL(require.resolve("werift"))).href;
  const bundled = await build({
    entryPoints: ["src/webrtc.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    external: ["werift"],
  });
  const code = bundled.outputFiles[0]!.text.replaceAll('"werift"', JSON.stringify(werift));
  const transport = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const script = `
    import { createServer } from "node:net";
    import { MediaStream, MediaStreamTrack } from ${JSON.stringify(werift)};
    import { WebRtcTransport } from ${JSON.stringify(transport)};
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const track = new MediaStreamTrack({ kind: "audio" });
    const stream = new MediaStream([track]);
    const server = new WebRtcTransport({ iceServers: [], localStream: stream });
    const client = new WebRtcTransport({ iceServers: [] });
    try {
      await server.listen({ host: "127.0.0.1", port,
        onRequest: () => ({ status: 200, headers: {}, body: "ok" }) });
      await client.execute({ method: "POST", headers: {},
        url: "webrtc://127.0.0.1:" + port + "/signal", receiveAudio: true });
    } finally {
      setTimeout(() => {
        console.error("Shutdown leaked an event-loop resource");
        process.exit(1);
      }, 5000).unref();
      await client.close();
      await server.close();
      track.stop();
    }
    console.log("CLEAN_SHUTDOWN");
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    "Deno" in globalThis
      ? ["eval", "--no-config", "--no-lock", "--node-modules-dir=manual", script]
      : ["--input-type=module", "-e", script],
    {
      timeout: 25_000,
      maxBuffer: 1_000_000,
    },
  );
  expect(stdout).toContain("CLEAN_SHUTDOWN");
}, 30_000);

it("Werift closes displaced BUNDLE transports without transport-side cleanup", async () => {
  const require = createRequire(import.meta.url);
  const werift = new URL("../../index.mjs", pathToFileURL(require.resolve("werift"))).href;
  const script = `
    import assert from "node:assert/strict";
    import { RTCPeerConnection, MediaStreamTrack } from ${JSON.stringify(werift)};
    const offerer = new RTCPeerConnection({ iceServers: [], iceUseDefaultStunServer: false });
    const answerer = new RTCPeerConnection({ iceServers: [], iceUseDefaultStunServer: false });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTrack(track);
    offerer.createDataChannel("bundle-cleanup");
    let displaced = [];
    try {
      await offerer.setLocalDescription(await offerer.createOffer());
      const previous = [...offerer.dtlsTransports];
      await answerer.setRemoteDescription(offerer.localDescription);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription);
      displaced = previous.filter(t => !offerer.dtlsTransports.includes(t));
      assert.ok(displaced.length > 0, "Must exercise BUNDLE transport displacement");
    } finally {
      setTimeout(() => {
        console.error("Raw Werift BUNDLE cleanup leaked an event-loop resource");
        process.exit(1);
      }, 5000).unref();
      await offerer.close();
      await answerer.close();
      track.stop();
    }
    for (const transport of displaced) {
      assert.equal(transport.state, "closed");
      assert.equal(transport.iceTransport.state, "closed");
    }
    console.log("RAW_BUNDLE_CLEANUP");
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    "Deno" in globalThis
      ? ["eval", "--no-config", "--no-lock", "--node-modules-dir=manual", script]
      : ["--input-type=module", "-e", script],
    { timeout: 25_000, maxBuffer: 1_000_000 },
  );
  expect(stdout).toContain("RAW_BUNDLE_CLEANUP");
}, 30_000);
