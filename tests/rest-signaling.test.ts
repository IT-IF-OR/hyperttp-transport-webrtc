import { expect, it, vi } from "vitest";
import type { RTCPeerConnection } from "werift";
import { createWebRtcRestSignalingHandler, WebRtcTransport } from "../src/index.js";

it("bridges REST routes, preserves owner isolation and closes sessions", async () => {
  const close = vi.fn(async () => {});
  const transport = new WebRtcTransport({
    iceServers: [],
    logger: () => {},
    createPeerConnection: () =>
      ({
        dtlsTransports: [],
        iceGatheringState: "complete",
        localDescription: { type: "answer", sdp: "answer" },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addTrack: vi.fn(),
        setRemoteDescription: vi.fn(async () => {}),
        createAnswer: vi.fn(async () => ({ type: "answer", sdp: "answer" })),
        setLocalDescription: vi.fn(async () => {}),
        close,
      }) as unknown as RTCPeerConnection,
  });
  const events: string[] = [];
  transport.onServerSession((event) => events.push(event.type));
  const signaling = transport.createSignalingHandler({
    signaling: {
      path: "/signal",
      authorize: (req) => ({ ownerId: String(req.headers.authorization) }),
    },
  });
  const route = createWebRtcRestSignalingHandler(signaling);
  const request = (method: string, owner: string) => ({
    method,
    path: "/signal",
    query: { sessionId: "session" },
    headers: { authorization: owner },
    context: { signal: new AbortController().signal },
    body: { sessionId: "session", sdp: { type: "offer", sdp: "offer" } },
  });
  try {
    const result = await route(request("POST", "alice"));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ type: "answer", sdp: "answer" });
    expect((await route(request("POST", "bob"))).status).toBe(403);
    expect((await route(request("DELETE", "bob"))).status).toBe(403);
    expect((await route(request("POST", "alice"))).status).toBe(200);
    expect((await route(request("DELETE", "alice"))).status).toBe(204);
    expect(close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["created", "closed"]);
  } finally {
    await signaling.close();
    await transport.close();
  }
});

it("forwards query parameters and cancellation and decodes JSON responses", async () => {
  const handle = vi.fn(async (_request: import("@hyperttp/types").TransportRequest) => ({
    status: 400,
    headers: { "content-type": "application/json" },
    body: '{"error":"bad"}',
  }));
  const route = createWebRtcRestSignalingHandler({
    handle,
    close: async () => {},
    closeServerSession: async () => {},
  });
  const controller = new AbortController();
  await expect(
    route({
      method: "GET",
      path: "/signal",
      query: { sessionId: "a b", tag: ["one", "two"] },
      headers: {},
      context: { signal: controller.signal },
    }),
  ).resolves.toMatchObject({ body: { error: "bad" } });
  expect(handle.mock.calls[0]?.[0]).toMatchObject({
    url: "/signal?sessionId=a+b&tag=one&tag=two",
    signal: controller.signal,
  });
});
