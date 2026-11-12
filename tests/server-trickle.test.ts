import { createServer } from "node:http";
import { expect, it } from "vitest";
import { RTCPeerConnection } from "werift";
import { WebRtcTransport } from "../src/webrtc.js";

it("supports owner-scoped trickle generations and cleans up", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = new WebRtcTransport({
    iceServers: [],
    createPeerConnection: () => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      // Test-only hook to hold the answerer's ICE gathering open.
      const hooks = pc as unknown as { gatherCandidates(): Promise<void> };
      const gather = hooks.gatherCandidates.bind(pc);
      hooks.gatherCandidates = async () => {
        await gate;
        await gather();
      };
      return pc;
    },
  });
  const peer = new RTCPeerConnection({ iceServers: [] });
  peer.createDataChannel("test");
  const url = `http://127.0.0.1:${address.port}/signal`;
  const headers = { authorization: "alice", "content-type": "application/json" };
  try {
    await transport.listen({
      host: "127.0.0.1",
      port: address.port,
      signaling: {
        path: "/signal",
        authorize: (req) => ({ ownerId: String(req.headers?.authorization) }),
      },
    });
    await peer.setLocalDescription(await peer.createOffer());
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s", sdp: peer.localDescription, trickle: true }),
    });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as {
      generation: string;
      sdp: RTCSessionDescriptionInit;
    };
    expect(answer.sdp.type).toBe("answer");
    const endpoint = `${url}?sessionId=s&generation=${answer.generation}`;
    expect((await fetch(endpoint, { headers: { authorization: "bob" } })).status).toBe(403);
    expect((await fetch(`${url}?sessionId=s&generation=old`, { headers })).status).toBe(409);
    const patch = (candidate: unknown, generation = answer.generation) =>
      fetch(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ sessionId: "s", generation, candidate }),
      });
    expect((await patch(null, "old")).status).toBe(409);
    expect((await patch({ candidate: "x" })).status).toBe(400);
    expect((await patch(null)).status).toBe(204);
    expect((await patch(null)).status).toBe(429);
    release();
    await expect
      .poll(
        async () => {
          const result = (await (await fetch(endpoint, { headers })).json()) as {
            candidates: unknown[];
          };
          return result.candidates.includes(null);
        },
        { timeout: 5000 },
      )
      .toBe(true);
    const listing = (await (await fetch(endpoint, { headers })).json()) as {
      candidates: unknown[];
      next: number;
    };
    expect(listing.next).toBe(listing.candidates.length);
    expect(
      (await (await fetch(`${endpoint}&cursor=${listing.next}`, { headers })).json()).candidates,
    ).toEqual([]);
    expect((await fetch(`${url}?sessionId=s`, { method: "DELETE", headers })).status).toBe(204);
    expect((await fetch(endpoint, { headers })).status).toBe(404);
  } finally {
    release();
    await transport.close();
    await peer.close();
  }
}, 15000);
