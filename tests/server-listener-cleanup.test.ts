import { expect, it, vi } from "vitest";
import type { RTCPeerConnection } from "werift";
import { WebRtcTransport } from "../src/webrtc.js";

type Listener = EventListener;

it("removes only transport server peer and channel listeners when a session closes", async () => {
  const peerListeners = new Map<string, Set<Listener>>();
  const channelListeners = new Map<string, Set<Listener>>();
  const addPeerListener = vi.fn((type: string, listener: Listener) => {
    const listeners = peerListeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    peerListeners.set(type, listeners);
  });
  const removePeerListener = vi.fn((type: string, listener: Listener) => {
    peerListeners.get(type)?.delete(listener);
  });
  const addChannelListener = vi.fn((type: string, listener: Listener) => {
    const listeners = channelListeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    channelListeners.set(type, listeners);
  });
  const removeChannelListener = vi.fn((type: string, listener: Listener) => {
    channelListeners.get(type)?.delete(listener);
  });
  const applicationPeerListener = vi.fn();
  const applicationChannelListener = vi.fn();
  const channel = {
    readyState: "open",
    send: vi.fn(),
    addEventListener: addChannelListener,
    removeEventListener: removeChannelListener,
  };
  const peer = {
    dtlsTransports: [],
    iceGatheringState: "complete",
    localDescription: { type: "answer", sdp: "answer" },
    addEventListener: addPeerListener,
    removeEventListener: removePeerListener,
    addTrack: vi.fn(),
    setRemoteDescription: vi.fn(async () => {}),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "answer" })),
    setLocalDescription: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  peer.addEventListener("track", applicationPeerListener);
  channel.addEventListener("message", applicationChannelListener);

  const transport = new WebRtcTransport({
    iceServers: [],
    logger: () => {},
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
  });
  const handler = transport.createSignalingHandler({ signaling: { path: "/signal" } });

  const response = await handler.handle({
    protocol: "webrtc",
    method: "POST",
    url: "/signal",
    headers: {},
    body: JSON.stringify({ sessionId: "session", sdp: { type: "offer", sdp: "offer" } }),
  });
  expect(response.status).toBe(200);

  const onDataChannel = [...(peerListeners.get("datachannel") ?? [])][0];
  expect(onDataChannel).toBeDefined();
  onDataChannel?.({ channel } as unknown as Event);

  await transport.closeServerSession("session");

  expect(peerListeners.get("datachannel")).toEqual(new Set());
  expect(peerListeners.get("connectionstatechange")).toEqual(new Set());
  expect(peerListeners.get("track")).toEqual(new Set([applicationPeerListener]));
  expect(channelListeners.get("message")).toEqual(new Set([applicationChannelListener]));
  expect(removePeerListener).not.toHaveBeenCalledWith("track", applicationPeerListener);
  expect(removeChannelListener).not.toHaveBeenCalledWith("message", applicationChannelListener);

  await handler.close();
  await transport.close();
});
