import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("exits naturally after closing a bundled audio and data-channel session", async () => {
  // A runner can hide leaked handles. Test shutdown in a separate process instead.
  const require = createRequire(import.meta.url);
  const werift = pathToFileURL(require.resolve("werift")).href;
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
    ["--input-type=module", "-e", script],
    {
      timeout: 25_000,
      maxBuffer: 1_000_000,
    },
  );
  expect(stdout).toContain("CLEAN_SHUTDOWN");
}, 30_000);
