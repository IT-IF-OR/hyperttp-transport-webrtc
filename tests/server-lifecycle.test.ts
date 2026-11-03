import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { RTCPeerConnection, MediaStream } from "werift";
import { WebRtcTransport, type WebRtcTransportOptions } from "../src/webrtc.js";
import type { WebRtcServerSessionEvent } from "../src/types/types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function fixture(options: Partial<WebRtcTransportOptions> = {}) {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw Error("No address");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const peers: ReturnType<typeof peer>[] = [];
  function peer() {
    return {
      dtlsTransports: [],
      iceGatheringState: "complete",
      localDescription: { type: "answer", sdp: "complete-answer" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addTrack: vi.fn(),
      setRemoteDescription: vi.fn(async () => {}),
      createAnswer: vi.fn(async () => ({ type: "answer", sdp: "complete-answer" })),
      setLocalDescription: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
  }
  const transport = new WebRtcTransport({
    iceServers: [],
    logger: () => {},
    createPeerConnection: () => {
      const pc = peer();
      peers.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    ...options,
  });
  const events: WebRtcServerSessionEvent[] = [];
  transport.onServerSession((event) => events.push(event));
  const server = await transport.listen({
    port: address.port,
    signaling: {
      path: "/signal",
      authorize: (request) =>
        request.headers.authorization === "alice-token"
          ? { ownerId: "alice", context: { role: "speaker" } }
          : request.headers.authorization === "bob-token"
            ? { ownerId: "bob" }
            : false,
    },
  });
  cleanup.push(() => transport.close());
  const url = `http://127.0.0.1:${address.port}/signal`;
  const post = (owner = "alice", sessionId = "session") =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `${owner}-token`,
        "x-owner-id": "alice",
      },
      body: JSON.stringify({ sessionId, ownerId: "alice", sdp: { type: "offer", sdp: "offer" } }),
    });
  const remove = (owner = "alice") =>
    fetch(`${url}?sessionId=session`, {
      method: "DELETE",
      headers: { authorization: `${owner}-token` },
    });
  return { transport, server, peers, events, post, remove };
}

it("binds ownership to auth result, denies another owner and reuses media on repeated offers", async () => {
  const media = vi.fn(
    (
      _sessionId: string,
      _context: { ownerId: string | undefined; authorization: unknown; signal: AbortSignal },
    ) => undefined,
  );
  const f = await fixture({ localStream: media });
  expect((await f.post()).status).toBe(200);
  expect(media.mock.calls[0]?.[1]).toMatchObject({
    ownerId: "alice",
    authorization: { role: "speaker" },
  });
  expect((await f.post("bob")).status).toBe(403);
  expect((await f.remove("bob")).status).toBe(403);
  expect(f.peers[0]?.setRemoteDescription).toHaveBeenCalledTimes(1);
  expect((await f.post()).status).toBe(200);
  expect(media).toHaveBeenCalledTimes(1);
  expect(f.peers).toHaveLength(1);
  expect((await f.remove()).status).toBe(204);
  expect((await f.remove()).status).toBe(204);
  expect(f.peers[0]?.close).toHaveBeenCalledTimes(1);
  expect(f.events.map((event) => event.type)).toEqual(["created", "closed"]);
});

it("aborts a pending media factory on DELETE and disposes a late stream exactly once", async () => {
  let finish!: (stream: MediaStream) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal!: AbortSignal;
  const dispose = vi.fn();
  const stop = vi.fn();
  const stream = {
    getTracks: () => [{ id: "track", readyState: "live", stop }],
  } as unknown as MediaStream;
  const f = await fixture({
    disposeLocalStream: dispose,
    localStream: (_id, context) => {
      signal = context.signal;
      entered();
      return new Promise<MediaStream>((resolve) => {
        finish = resolve;
      });
    },
  });
  const response = f.post();
  await ready;
  expect((await f.post()).status).toBe(409);
  expect((await f.remove("bob")).status).toBe(403);
  expect(signal.aborted).toBe(false);
  expect((await f.remove()).status).toBe(204);
  expect(signal.aborted).toBe(true);
  finish(stream);
  expect((await response).status).toBe(503);
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(f.peers[0]?.addTrack).not.toHaveBeenCalled();
  await f.transport.closeServerSession("session");
  expect(f.events.map((event) => event.type)).toEqual(["created", "closed"]);
});

it("shares concurrent close and emits cleanup events on shutdown", async () => {
  const dispose = vi.fn();
  const stop = vi.fn();
  const stream = {
    getTracks: () => [{ id: "track", readyState: "live", stop }],
  } as unknown as MediaStream;
  const f = await fixture({ localStream: async () => stream, disposeLocalStream: dispose });
  expect((await f.post()).status).toBe(200);
  const first = f.transport.closeServerSession("session");
  expect(f.transport.closeServerSession("session")).toBe(first);
  await first;
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
  expect((await f.post("alice", "second")).status).toBe(200);
  await f.server.close();
  expect(f.events.filter((event) => event.type === "closed")).toHaveLength(2);
  expect(f.transport.getServerSession("second")).toBeUndefined();
});
