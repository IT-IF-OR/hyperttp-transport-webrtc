import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { RTCPeerConnection as WeriftPeer } from "werift";
import { expect, it } from "vitest";
import { createPcmAudioSource } from "../src/pcm-audio.js";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium";
const available =
  existsSync(executablePath) &&
  spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes(
    "libopus",
  );

it.skipIf(!available)(
  "Chromium decodes real FFmpeg Opus over WebRTC",
  async () => {
    const frame = new Int16Array(960 * 2);
    for (let i = 0; i < 960; i++)
      frame[i * 2] = frame[i * 2 + 1] = Math.round(
        Math.sin((i * 2 * Math.PI * 440) / 48000) * 12000,
      );
    const pcm = new Uint8Array(frame.buffer);
    const audio = await createPcmAudioSource({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 600; i++) yield pcm;
      },
    });
    const subscription = audio.subscribe();
    const server = new WeriftPeer({ iceServers: [] });
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    try {
      const page = await browser.newPage();
      await page.exposeFunction("answerOffer", async (sdp: string) => {
        await server.setRemoteDescription({ type: "offer", sdp });
        server.addTrack(subscription.stream.getAudioTracks()[0]!, subscription.stream);
        await server.setLocalDescription(await server.createAnswer());
        return server.localDescription!.sdp;
      });
      await page.evaluate(async () => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        (window as unknown as { testPeer: RTCPeerConnection }).testPeer = pc;
        pc.ontrack = ({ streams }) => {
          const element = new Audio();
          element.srcObject = streams[0] ?? null;
          void element.play();
        };
        pc.addTransceiver("audio", { direction: "recvonly" });
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") return resolve();
          pc.addEventListener("icegatheringstatechange", () => {
            if (pc.iceGatheringState === "complete") resolve();
          });
        });
        const answer = await (
          window as unknown as { answerOffer: (sdp: string) => Promise<string> }
        ).answerOffer(pc.localDescription!.sdp);
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
      });
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const pc = (window as unknown as { testPeer: RTCPeerConnection }).testPeer;
              const stats = await pc.getStats();
              const inbound = [...stats.values()].find(
                (item) => item.type === "inbound-rtp" && item.kind === "audio",
              );
              return inbound?.totalSamplesReceived ?? 0;
            }),
          { timeout: 8000 },
        )
        .toBeGreaterThan(48000);
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const stats = await (
                window as unknown as { testPeer: RTCPeerConnection }
              ).testPeer.getStats();
              const inbound = [...stats.values()].find(
                (item) => item.type === "inbound-rtp" && item.kind === "audio",
              );
              return inbound?.totalAudioEnergy ?? 0;
            }),
          { timeout: 8000 },
        )
        .toBeGreaterThan(0);
    } finally {
      await browser.close();
      await server.close();
      subscription.close();
      await audio.close();
    }
  },
  30000,
);
