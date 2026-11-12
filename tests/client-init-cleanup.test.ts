import { expect, it, vi } from "vitest";
import { WebRtcTransport } from "../src/webrtc.js";

type FailurePoint = "createDataChannel" | "createMediaStream" | "addEventListener";

function peerThatFailsAt(failurePoint: FailurePoint) {
  const close = vi.fn(async () => {});
  const channel = Object.assign(new EventTarget(), {
    readyState: "connecting",
    close: vi.fn(),
  });
  const peer = Object.assign(new EventTarget(), {
    connectionState: "new",
    signalingState: "stable",
    iceGatheringState: "new",
    close,
    createDataChannel: () => {
      if (failurePoint === "createDataChannel") throw new Error("createDataChannel failed");
      return channel;
    },
    addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
      if (failurePoint === "addEventListener") throw new Error("addEventListener failed");
      EventTarget.prototype.addEventListener.call(this, name, listener);
    },
  });
  return { close, peer };
}

it.each<FailurePoint>(["createDataChannel", "createMediaStream", "addEventListener"])(
  "closes the peer when %s throws synchronously during client initialization",
  async (failurePoint) => {
    const { close, peer } = peerThatFailsAt(failurePoint);
    const transport = new WebRtcTransport({
      iceServers: [],
      createPeerConnection: () => peer as any,
      createMediaStream: () => {
        if (failurePoint === "createMediaStream") throw new Error("createMediaStream failed");
        return { getTracks: () => [], addTrack() {} } as any;
      },
      logger: () => {},
    });

    await expect(
      transport.execute({
        protocol: "webrtc",
        method: "GET",
        headers: {},
        url: "webrtc://example.test/signal",
      }),
    ).rejects.toThrow(`${failurePoint} failed`);
    expect(close).toHaveBeenCalledOnce();
    await expect(transport.close()).resolves.toBeUndefined();
  },
);

it("does not create a replacement session when close wins while disposing the old one", async () => {
  let releaseDispose!: () => void;
  const disposing = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  const oldPeer = Object.assign(new EventTarget(), {
    connectionState: "failed",
    close: vi.fn(async () => await disposing),
  });
  const replacementFactory = vi.fn();
  const transport = new WebRtcTransport({
    iceServers: [],
    createPeerConnection: replacementFactory,
    logger: () => {},
  });
  const sessions = (transport as any).sessions as Map<string, any>;
  sessions.set("webrtc://example.test/signal", {
    id: "old",
    peerUrl: "webrtc://example.test/signal",
    signalingUrl: "http://example.test/signal",
    peerConnection: oldPeer,
    dataChannel: { readyState: "closed", close() {} },
    pending: new Map(),
    negotiation: Promise.resolve(),
    closed: false,
    trackEndedListenerCleanup: new Set(),
  });

  const request = transport.execute({
    protocol: "webrtc",
    method: "GET",
    headers: {},
    url: "webrtc://example.test/signal",
  });
  await Promise.resolve();
  const closing = transport.close();
  releaseDispose();

  await expect(request).rejects.toThrow(/closed/i);
  await expect(closing).resolves.toBeUndefined();
  expect(replacementFactory).not.toHaveBeenCalled();
});
