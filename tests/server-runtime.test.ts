import { describe, expect, it } from "vitest";
import { createWebRtcPeerConnection, createWebRtcRuntime } from "../src/runtime.js";

describe("server runtime facade", () => {
  it("uses GCC by default and preserves explicit peer settings", async () => {
    const peer = createWebRtcPeerConnection({
      iceServers: [],
      iceAdditionalHostAddresses: ["203.0.113.1"],
      icePortRange: [40_000, 40_001],
    });
    try {
      expect(peer.config.bandwidthEstimator).toBe("gcc");
      expect(peer.config.iceServers).toEqual([]);
      expect(peer.config.iceAdditionalHostAddresses).toEqual(["203.0.113.1"]);
      expect(peer.config.icePortRange).toEqual([40_000, 40_001]);
    } finally {
      await peer.close();
    }
  });

  it.each(["lightweight", "none", false] as const)(
    "preserves the explicit estimator %s",
    async (bandwidthEstimator) => {
      const peer = createWebRtcPeerConnection({ iceServers: [], bandwidthEstimator });
      try {
        expect(peer.config.bandwidthEstimator).toBe(bandwidthEstimator);
      } finally {
        await peer.close();
      }
    },
  );

  it("caches runtime loading and exposes peer and PCM factories", async () => {
    const runtime = createWebRtcRuntime();
    const first = runtime.load();
    expect(runtime.load()).toBe(first);
    const loaded = await first;
    expect(loaded.createPeer).toBe(createWebRtcPeerConnection);
    expect(typeof loaded.createAudio).toBe("function");
  });
});
