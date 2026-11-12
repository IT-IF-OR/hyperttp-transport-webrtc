import { afterEach, expect, it, vi } from "vitest";
import { WebRtcTransport } from "../src/browser.js";

class Peer extends EventTarget {
  localDescription = { type: "offer", sdp: "offer" };
  iceGatheringState = "complete";
  applied: unknown[] = [];
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {
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
  const transport = new WebRtcTransport({ trickleIce, iceGatheringTimeoutMs: 200 });
  const session: {
    peerConnection: Peer;
    controller: AbortController;
    id: string;
    signalingUrl: string;
    signaled: boolean;
    cleanup: (() => void)[];
    pending: Map<string, (error?: unknown, response?: unknown) => void>;
    dataChannel: { close(): void };
    peerUrl: string;
    exchange?: Promise<void>;
  } = {
    peerConnection: pc,
    controller: new AbortController(),
    id: "s",
    signalingUrl: "http://localhost/signal",
    signaled: false,
    cleanup: [] as (() => void)[],
    pending: new Map(),
    dataChannel: { close() {} },
    peerUrl: "webrtc://localhost/signal",
  };
  const negotiate = (signal?: AbortSignal) =>
    (transport as any).negotiate(session, signal) as Promise<void>;
  return { pc, session, negotiate };
}
afterEach(() => vi.unstubAllGlobals());

function responseWithCancelableBody(status: number, statusText = "") {
  const cancel = vi.fn();
  return {
    cancel,
    response: new Response(new ReadableStream({ cancel }), { status, statusText }),
  };
}

it("cancels failed trickle POST response bodies without replacing the HTTP error", async () => {
  const { negotiate } = setup();
  const { cancel, response } = responseWithCancelableBody(500, "Server Error");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );

  await expect(negotiate()).rejects.toThrow("Signaling HTTP error: 500 Server Error");
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels failed trickle PATCH response bodies without replacing the HTTP error", async () => {
  const { session, negotiate } = setup();
  const { cancel, response } = responseWithCancelableBody(500);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init = {}) => {
      if (init.method === "POST")
        return Response.json({ generation: "g", sdp: { type: "answer", sdp: "answer" } });
      if (init.method === "PATCH") return response;
      return new Promise<Response>((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
      );
    }),
  );

  await negotiate();
  await expect(session.exchange!).rejects.toThrow("ICE candidate HTTP error: 500");
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels failed trickle GET response bodies without replacing the HTTP error", async () => {
  const { session, negotiate } = setup();
  const { cancel, response } = responseWithCancelableBody(500);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init = {}) => {
      if (init.method === "POST")
        return Response.json({ generation: "g", sdp: { type: "answer", sdp: "answer" } });
      if (init.method === "PATCH") return new Response(null, { status: 204 });
      return response;
    }),
  );

  await negotiate();
  await expect(session.exchange!).rejects.toThrow("ICE polling HTTP error: 500");
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels DELETE response bodies during best-effort cleanup", async () => {
  const { session } = setup();
  const { cancel, response } = responseWithCancelableBody(500);
  session.signaled = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );

  await (new WebRtcTransport() as any).dispose(session);
  expect(cancel).toHaveBeenCalledOnce();
});

it("exchanges candidates in order and applies the answer first", async () => {
  const { pc, session, negotiate } = setup();
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
  expect(session.exchange).toBeDefined();
  await session.exchange;
  expect(patches).toEqual([{ candidate: "local", sdpMid: "0" }, null]);
  expect(pc.applied).toEqual(["answer", { candidate: "remote", sdpMid: "0" }, null]);
});

it("rejects invalid cursor and aborts the other direction", async () => {
  const { session, negotiate } = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init = {}) => {
      if (init.method === "POST")
        return Response.json({ generation: "g", sdp: { type: "answer", sdp: "answer" } });
      if (init.method === "PATCH") return new Response(null, { status: 204 });
      return Response.json({ generation: "g", candidates: [null], next: 0 });
    }),
  );
  await negotiate();
  expect(session.exchange).toBeDefined();
  await expect(session.exchange!).rejects.toThrow("invalid ICE candidate page");
});

it("cancels an outstanding poll", async () => {
  const { negotiate } = setup();
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init = {}) => {
      if (init.method === "POST")
        return Response.json({ generation: "g", sdp: { type: "answer", sdp: "answer" } });
      if (init.method === "PATCH") return new Response(null, { status: 204 });
      controller.abort(new Error("cancelled"));
      return Response.json({ generation: "g", candidates: [], next: 0 });
    }),
  );
  await expect(negotiate(controller.signal)).rejects.toThrow("cancelled");
});

it("keeps legacy signaling by default", async () => {
  const { negotiate } = setup(false);
  const fetchMock = vi.fn(async (_url, init) => {
    expect(JSON.parse(init.body).trickle).toBeUndefined();
    return Response.json({ type: "answer", sdp: "answer" });
  });
  vi.stubGlobal("fetch", fetchMock);
  await negotiate();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
