import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RTCPeerConnection } from "werift";
import { WebRtcTransport } from "../src/webrtc.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function start(createPeerConnection: () => RTCPeerConnection) {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const transport = new WebRtcTransport({ createPeerConnection });
  cleanup.push(() => transport.close());
  await transport.listen({ host: "127.0.0.1", port: address.port });
  return { transport, url: `http://127.0.0.1:${address.port}` };
}

async function createOffer() {
  const client = new RTCPeerConnection();
  cleanup.push(() => client.close());
  const offer = await client.createOffer();
  await client.setLocalDescription(offer);
  return offer;
}

describe("signaling session close races", () => {
  it("aborts an in-flight offer when its server session closes", async () => {
    const peer = new RTCPeerConnection();
    const remoteDescription = deferred<void>();
    const setRemoteDescription = vi
      .spyOn(peer, "setRemoteDescription")
      .mockImplementation(() => remoteDescription.promise);
    const { transport, url } = await start(() => peer);
    const offer = await createOffer();

    const responsePromise = fetch(`${url}/signal`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "offer-race", sdp: offer }),
    });
    await vi.waitFor(() => expect(setRemoteDescription).toHaveBeenCalledOnce());

    await transport.closeServerSession("offer-race");
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "WebRTC session closed" });

    remoteDescription.resolve();
  });

  it("does not close a replacement session when a stale offer aborts", async () => {
    const peer = new RTCPeerConnection();
    const remoteDescription = deferred<void>();
    vi.spyOn(peer, "setRemoteDescription").mockImplementation(() => remoteDescription.promise);
    const { transport, url } = await start(() => peer);
    const offer = await createOffer();

    const responsePromise = fetch(`${url}/signal`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "replaced-session", sdp: offer }),
    });
    await vi.waitFor(() => expect(transport.getServerSession("replaced-session")).toBeDefined());

    const sessions = (transport as unknown as { serverSessions: Map<string, any> }).serverSessions;
    const original = sessions.get("replaced-session");
    const replacementPeer = new RTCPeerConnection();
    const replacement = {
      ...original,
      closed: false,
      controller: new AbortController(),
      peerConnection: replacementPeer,
      release: () => {},
    };
    const replacementClose = vi.spyOn(replacementPeer, "close");

    void transport.closeServerSession("replaced-session");
    sessions.set("replaced-session", replacement);

    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(replacementClose).not.toHaveBeenCalled();
    expect(sessions.get("replaced-session")).toBe(replacement);

    await transport.closeServerSession("replaced-session");
    remoteDescription.resolve();
  });

  it("does not close a replacement session when a trickle operation rejects late", async () => {
    const peer = new RTCPeerConnection();
    const localDescription = deferred<Awaited<ReturnType<typeof peer.setLocalDescription>>>();
    const setLocalDescription = vi
      .spyOn(peer, "setLocalDescription")
      .mockImplementation(() => localDescription.promise);
    const { transport, url } = await start(() => peer);
    const offer = await createOffer();

    const responsePromise = fetch(`${url}/signal`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "trickle-replaced", trickle: true, sdp: offer }),
    });
    await vi.waitFor(() => expect(setLocalDescription).toHaveBeenCalledOnce());

    const sessions = (transport as unknown as { serverSessions: Map<string, any> }).serverSessions;
    const original = sessions.get("trickle-replaced");
    const replacementPeer = new RTCPeerConnection();
    const replacement = {
      ...original,
      closed: false,
      controller: new AbortController(),
      peerConnection: replacementPeer,
      release: () => {},
    };
    const replacementClose = vi.spyOn(replacementPeer, "close");

    void transport.closeServerSession("trickle-replaced");
    sessions.set("trickle-replaced", replacement);

    const response = await responsePromise;
    expect(response.status).toBe(503);
    localDescription.reject(new Error("late signaling failure"));
    await vi.waitFor(() => expect(replacementClose).not.toHaveBeenCalled());
    expect(sessions.get("trickle-replaced")).toBe(replacement);

    await transport.closeServerSession("trickle-replaced");
  });

  it("aborts an in-flight ICE PATCH when its server session closes", async () => {
    const peer = new RTCPeerConnection();
    const { transport, url } = await start(() => peer);
    const offer = await createOffer();
    const offerResponse = await fetch(`${url}/signal`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "patch-race", trickle: true, sdp: offer }),
    });
    expect(offerResponse.status).toBe(200);
    const { generation } = (await offerResponse.json()) as { generation: string };

    const addIceCandidate = deferred<void>();
    const addCandidate = vi
      .spyOn(peer, "addIceCandidate")
      .mockImplementation(() => addIceCandidate.promise);
    const responsePromise = fetch(`${url}/signal`, {
      method: "PATCH",
      body: JSON.stringify({
        sessionId: "patch-race",
        generation,
        candidate: {
          candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host",
          sdpMid: "0",
        },
      }),
    });
    await vi.waitFor(() => expect(addCandidate).toHaveBeenCalledOnce());

    await transport.closeServerSession("patch-race");
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "WebRTC signaling request aborted" });

    addIceCandidate.resolve();
  });
});
