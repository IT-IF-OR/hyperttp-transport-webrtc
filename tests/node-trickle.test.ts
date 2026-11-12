import { createServer } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { WebRtcTransport } from "../src/webrtc.js";

class Peer extends EventTarget {
  signalingState = "stable";
  iceGatheringState = "complete";
  localDescription = { type: "offer", sdp: "offer" };
  dtlsTransports: never[] = [];
  applied: unknown[] = [];
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {
    this.signalingState = "have-local-offer";
    for (const candidate of [{ candidate: "local", sdpMid: "0" }, null]) {
      const event = new Event("icecandidate");
      Object.assign(event, { candidate: candidate && { toJSON: () => candidate } });
      this.dispatchEvent(event);
    }
  }
  async setRemoteDescription() {
    this.applied.push("answer");
  }
  async addIceCandidate(candidate: unknown) {
    this.applied.push(candidate);
  }
}

function setup(trickleIce = true) {
  const pc = new Peer();
  const transport = new WebRtcTransport({
    trickleIce,
    iceGatheringTimeoutMs: 300,
    signalingTimeoutMs: 300,
  });
  const session = { peerConnection: pc, id: "s", signalingUrl: "http://localhost/signal" };
  return {
    pc,
    negotiate: (signal?: AbortSignal) =>
      (transport as any).negotiate(session, signal) as Promise<void>,
  };
}

afterEach(() => vi.unstubAllGlobals());

it.each(["POST", "PATCH", "GET"])("cancels an unused %s error response body", async (method) => {
  const { negotiate } = setup();
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init = {}) => {
      const current = init.method ?? "GET";
      if (current === method) return new Response(new ReadableStream({ cancel }), { status: 500 });
      if (current === "POST")
        return Response.json({ generation: "g", sdp: { type: "answer", sdp: "answer" } });
      if (current === "PATCH") return new Response(null, { status: 204 });
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }),
  );
  await expect(negotiate()).rejects.toThrow(/HTTP error/);
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels an unused DELETE response body on session disposal", async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 500 })),
  );
  const transport = new WebRtcTransport();
  const session = {
    closed: false,
    peerUrl: "webrtc://localhost/signal",
    signalingUrl: "http://localhost/signal",
    id: "s",
    pending: new Map(),
    trackEndedListenerCleanup: new Set(),
    dataChannel: { close() {} },
    peerConnection: { close: async () => {} },
  };
  await (transport as any).disposeClientSession(session, true);
  expect(cancel).toHaveBeenCalledOnce();
  await transport.close();
});

it("exchanges trickle candidates in order after applying the answer", async () => {
  const { pc, negotiate } = setup();
  const patches: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init = {}) => {
      if (init.method === "POST") {
        expect(JSON.parse(init.body).trickle).toBe(true);
        return Response.json({ generation: "g", sdp: { type: "answer", sdp: "answer" } });
      }
      if (init.method === "PATCH") {
        patches.push(JSON.parse(init.body).candidate);
        return new Response(null, { status: 204 });
      }
      return Response.json({
        generation: "g",
        candidates: [{ candidate: "remote", sdpMid: "0" }, null],
        next: 2,
      });
    }),
  );
  await negotiate();
  expect(patches).toEqual([{ candidate: "local", sdpMid: "0" }, null]);
  expect(pc.applied).toEqual(["answer", { candidate: "remote", sdpMid: "0" }, null]);
});

it("sends the offer when signaling state changes without waiting for ICE gathering", async () => {
  const { pc, negotiate } = setup();
  let finishGathering!: () => void;
  pc.setLocalDescription = () => {
    pc.signalingState = "have-local-offer";
    pc.dispatchEvent(new Event("signalingstatechange"));
    return new Promise<void>((resolve) => {
      finishGathering = () => {
        pc.dispatchEvent(new Event("icecandidate"));
        resolve();
      };
    });
  };
  const fetchMock = vi.fn(async (_url, init = {}) => {
    if (init.method === "POST") {
      finishGathering();
      return Response.json({ generation: "g", sdp: { type: "answer", sdp: "answer" } });
    }
    if (init.method === "PATCH") return new Response(null, { status: 204 });
    return Response.json({ generation: "g", candidates: [null], next: 1 });
  });
  vi.stubGlobal("fetch", fetchMock);
  await negotiate();
  expect(fetchMock).toHaveBeenCalled();
});

it("removes its signaling listener when local description is aborted", async () => {
  const { pc, negotiate } = setup();
  pc.setLocalDescription = () => new Promise<void>(() => {});
  const remove = vi.spyOn(pc, "removeEventListener");
  const controller = new AbortController();
  const pending = negotiate(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(remove).toHaveBeenCalledWith("signalingstatechange", expect.any(Function));
});

it("rejects invalid candidate pages", async () => {
  const { negotiate } = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init = {}) => {
      if (init.method === "POST")
        return Response.json({ generation: "g", sdp: { type: "answer", sdp: "answer" } });
      if (init.method === "PATCH") return new Response(null, { status: 204 });
      return Response.json({ generation: "g", candidates: [null], next: 0 });
    }),
  );
  await expect(negotiate()).rejects.toThrow("invalid ICE candidate page");
});

it("round-trips through a real Werift trickle session", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const server = new WebRtcTransport({ iceServers: [] });
  const client = new WebRtcTransport({ iceServers: [], trickleIce: true });
  try {
    await server.listen({
      host: "127.0.0.1",
      port: address.port,
      onRequest: (request) => ({ status: 200, headers: {}, body: request.body }),
    });
    const url = `webrtc://127.0.0.1:${address.port}/signal`;
    const response = await client.execute({
      method: "POST",
      url,
      headers: {},
      protocol: "rest",
      body: "hello",
    });
    expect(response.body).toBe("hello");
  } finally {
    await client.close();
    await server.close();
  }
}, 15000);

it("preserves legacy signaling by default", async () => {
  const { negotiate } = setup(false);
  const fetchMock = vi.fn(async (_url, init) => {
    expect(JSON.parse(init.body).trickle).toBeUndefined();
    return Response.json({ type: "answer", sdp: "answer" });
  });
  vi.stubGlobal("fetch", fetchMock);
  await negotiate();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
