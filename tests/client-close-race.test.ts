import { afterEach, expect, it, vi } from "vitest";
import { WebRtcTransport } from "../src/webrtc.js";

type Stage = "createOffer" | "setLocalDescription";

afterEach(() => vi.unstubAllGlobals());

function pendingPeer(stage: Stage) {
  let reached = false;
  const channel = new EventTarget();
  Object.assign(channel, { readyState: "connecting", close() {} });
  const peer = new EventTarget();
  Object.assign(peer, {
    connectionState: "new",
    signalingState: "stable",
    iceGatheringState: "new",
    createDataChannel: () => channel,
    createOffer: () => {
      reached = true;
      return stage === "createOffer"
        ? new Promise<RTCSessionDescriptionInit>(() => {})
        : Promise.resolve({ type: "offer", sdp: "offer" });
    },
    setLocalDescription: () => {
      reached = true;
      return new Promise<void>(() => {});
    },
    close: async () => {},
    getSenders: () => [],
    getTransceivers: () => [],
  });
  return { peer, reached: () => reached };
}

async function expectCloseDuring(stage: Stage, trickleIce = false) {
  const { peer, reached } = pendingPeer(stage);
  const transport = new WebRtcTransport({
    iceServers: [],
    trickleIce,
    signalingTimeoutMs: 10_000,
    iceGatheringTimeoutMs: 10_000,
    createPeerConnection: () => peer as any,
    logger: () => {},
  });
  const request = transport.execute({
    protocol: "webrtc",
    method: "GET",
    headers: {},
    url: "webrtc://example.test/signal",
  });
  await Promise.resolve();

  await expect(transport.close()).resolves.toBeUndefined();
  await expect(request).rejects.toThrow(/aborted|closed/i);
  expect(reached()).toBe(true);
}

it("closes while a full-ICE client createOffer remains pending", () =>
  expectCloseDuring("createOffer"));

it("closes while a full-ICE client setLocalDescription remains pending", () =>
  expectCloseDuring("setLocalDescription"));

it("closes while a trickle client createOffer remains pending", () =>
  expectCloseDuring("createOffer", true));

it("closes while the data channel remains connecting without a close event", async () => {
  const channel = new EventTarget();
  Object.assign(channel, { readyState: "connecting", close() {} });
  const peer = new EventTarget();
  Object.assign(peer, {
    connectionState: "new",
    signalingState: "stable",
    iceGatheringState: "complete",
    localDescription: { type: "offer", sdp: "offer" },
    createDataChannel: () => channel,
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    close: async () => {},
    getSenders: () => [],
    getTransceivers: () => [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ type: "answer", sdp: "answer" })),
  );
  const transport = new WebRtcTransport({
    iceServers: [],
    connectionTimeoutMs: 10_000,
    createPeerConnection: () => peer as any,
    logger: () => {},
  });
  const request = transport.execute({
    protocol: "webrtc",
    method: "GET",
    headers: {},
    url: "webrtc://example.test/signal",
  });
  await Promise.resolve();

  await expect(transport.close()).resolves.toBeUndefined();
  await expect(request).rejects.toThrow(/aborted|closed/i);
});
