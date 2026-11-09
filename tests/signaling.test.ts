import { createServer, request } from "node:http";
import type { TransportRequest, TransportSignalingOptions } from "@hyperttp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RTCPeerConnection } from "werift";
import { WebRtcTransport } from "../src/webrtc.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function start(signaling?: TransportSignalingOptions) {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const createPeerConnection = vi.fn(() => {
    throw new Error("Unexpected peer creation");
  });
  const localStream = vi.fn(() => {
    throw new Error("Unexpected media access");
  });
  const transport = new WebRtcTransport({ createPeerConnection, localStream });
  cleanup.push(() => transport.close());
  const server = await transport.listen({ host: "127.0.0.1", port: address.port, signaling });
  return {
    transport,
    server,
    createPeerConnection,
    localStream,
    url: `http://127.0.0.1:${address.port}`,
  };
}

const offer = JSON.stringify({ sessionId: "test", sdp: { type: "offer", sdp: "test" } });

describe("transport signaling options", () => {
  it.each(["POST", "PATCH"])("returns a safe 400 for malformed %s JSON", async (method) => {
    const { url, createPeerConnection } = await start();
    const response = await fetch(`${url}/signal`, { method, body: '{"secret":' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON" });
    expect(createPeerConnection).not.toHaveBeenCalled();
  });

  it.each(["null", "42", '"value"', "{}"])(
    "rejects invalid POST payload %s before peer creation",
    async (body) => {
      const { url, createPeerConnection } = await start();
      const response = await fetch(`${url}/signal`, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(createPeerConnection).not.toHaveBeenCalled();
    },
  );

  it("returns a generic 500 when peer creation fails", async () => {
    const { url, createPeerConnection } = await start();
    createPeerConnection.mockImplementation(() => { throw new Error("secret peer failure"); });
    const response = await fetch(`${url}/signal`, { method: "POST", body: offer });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Signaling failed" });
  });

  it("returns a generic 500 and closes the session when negotiation fails", async () => {
    const { transport, url } = await start();
    const peer = new RTCPeerConnection({ iceServers: [] });
    const close = vi.spyOn(peer, "close");
    vi.spyOn(peer, "setRemoteDescription").mockRejectedValue(new Error("secret SDP failure"));
    vi.spyOn(transport as unknown as { createPeerConnection: () => RTCPeerConnection }, "createPeerConnection")
      .mockReturnValue(peer);
    const response = await fetch(`${url}/signal`, { method: "POST", body: offer });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Signaling failed" });
    await expect.poll(() => close.mock.calls.length).toBe(1);
    expect(transport.getServerSession("test")).toBeUndefined();
  });

  it("routes a custom path and preserves the default path", async () => {
    const authorize = vi.fn(() => true);
    const custom = await start({ path: "/rtc/signal", authorize });
    expect((await fetch(`${custom.url}/signal`, { method: "DELETE" })).status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(
      (await fetch(`${custom.url}/rtc/signal?sessionId=missing`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(authorize).toHaveBeenCalledOnce();
    const defaults = await start();
    expect((await fetch(`${defaults.url}/signal`, { method: "DELETE" })).status).toBe(204);
  });

  it.each(["POST", "DELETE"])(
    "denies %s before parsing, session access or media",
    async (method) => {
      const authorize = vi.fn((_request: TransportRequest) => false);
      const { transport, url, createPeerConnection, localStream } = await start({
        path: "/rtc",
        authorize,
      });
      // An unauthorized DELETE must not reach the session-closing operation.
      const closeSession = vi.spyOn(
        transport as unknown as { closeServerSession(id: string): Promise<void> },
        "closeServerSession",
      );
      const response = await fetch(`${url}/rtc?sessionId=test`, {
        method,
        headers: { authorization: "Bearer test" },
        ...(method === "POST" ? { body: "not JSON" } : {}),
      });
      expect(response.status).toBe(403);
      const raw = authorize.mock.calls[0]![0];
      expect(raw).toMatchObject({
        protocol: "webrtc",
        method,
        url: "/rtc?sessionId=test",
        headers: { authorization: "Bearer test" },
      });
      expect(raw).not.toHaveProperty("body");
      expect(raw.signal).toBeInstanceOf(AbortSignal);
      expect(closeSession).not.toHaveBeenCalled();
      expect(createPeerConnection).not.toHaveBeenCalled();
      expect(localStream).not.toHaveBeenCalled();
    },
  );

  it.each(["POST", "DELETE"])("rejects a valid %s request before peer creation", async (method) => {
    const { url, createPeerConnection } = await start({
      path: "/signal",
      authorize: async () => false,
    });
    const response = await fetch(`${url}/signal?sessionId=test`, {
      method,
      ...(method === "POST" ? { body: offer } : {}),
    });
    expect(response.status).toBe(403);
    expect(createPeerConnection).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"])("hides authorization errors for %s", async (method) => {
    const { url, createPeerConnection } = await start({
      path: "/signal",
      authorize: async () => {
        throw new Error("secret credential");
      },
    });
    const response = await fetch(`${url}/signal`, {
      method,
      ...(method === "POST" ? { body: offer } : {}),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("secret");
    expect(createPeerConnection).not.toHaveBeenCalled();
  });

  it.each([
    "signal",
    "",
    "//example.com/signal",
    "/signal?x=1",
    "/signal#x",
    "/a/../signal",
    "/a\\b",
    "/a b",
  ])("rejects invalid path %j", async (path) => {
    const transport = new WebRtcTransport();
    await expect(transport.listen({ signaling: { path } })).rejects.toThrow(
      /absolute literal pathname/,
    );
    await transport.close();
  });

  it("does not create a session after listener shutdown during authorization", async () => {
    let allow!: (value: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let signal: AbortSignal | undefined;
    const { server, url, createPeerConnection } = await start({
      path: "/signal",
      authorize: (raw) => {
        signal = raw.signal;
        entered();
        return new Promise<boolean>((resolve) => {
          allow = resolve;
        });
      },
    });
    // Isolate authorization shutdown from the HTTP client's keep-alive lifetime.
    const response = fetch(`${url}/signal`, {
      method: "POST",
      body: offer,
      headers: { connection: "close" },
    });
    await started;
    const closing = server.close();
    expect(signal?.aborted).toBe(true);
    allow(true);
    const result = await response;
    expect(result.status).toBe(503);
    await result.arrayBuffer();
    await closing;
    expect(createPeerConnection).not.toHaveBeenCalled();
  });

  it("does not create a session after the client disconnects during authorization", async () => {
    let allow!: (value: boolean) => void;
    let entered!: () => void;
    let aborted!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const disconnected = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const { url, createPeerConnection } = await start({
      path: "/signal",
      authorize: (raw) => {
        raw.signal!.addEventListener("abort", aborted, { once: true });
        entered();
        return new Promise<boolean>((resolve) => {
          allow = resolve;
        });
      },
    });
    const req = request(`${url}/signal`, { method: "POST" });
    req.on("error", () => {});
    req.end(offer);
    await started;
    req.destroy();
    await disconnected;
    allow(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(createPeerConnection).not.toHaveBeenCalled();
  });
});
