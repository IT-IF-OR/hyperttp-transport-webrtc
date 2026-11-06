import { expect, it } from "vitest";
import { RTCPeerConnection } from "werift";

it("exposes local SDP while ICE gathering is still pending", async () => {
  const peer = new RTCPeerConnection({ iceServers: [] });
  peer.createDataChannel("test");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Test-only hook: Werift waits for this private method during setLocalDescription.
  const hooks = peer as unknown as { gatherCandidates(): Promise<void> };
  const original = hooks.gatherCandidates.bind(peer);
  hooks.gatherCandidates = async () => {
    await gate;
    await original();
  };
  try {
    const offer = await peer.createOffer();
    let finished = false;
    const applying = peer.setLocalDescription(offer).then(() => {
      finished = true;
    });
    await expect
      .poll(() => peer.localDescription?.sdp, { timeout: 3000 })
      .toContain("a=ice-ufrag:");
    expect(finished).toBe(false);
    release();
    await applying;
  } finally {
    release();
    await peer.close();
  }
}, 10000);
