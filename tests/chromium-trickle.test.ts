import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { WebRtcTransport } from "../src/webrtc.js";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium";

it.skipIf(!existsSync(executablePath))(
  "opens a real Chromium data channel using trickle ICE and round-trips a request",
  async () => {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("No TCP port allocated");
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );

    const server = new WebRtcTransport({ iceServers: [], iceGatheringTimeoutMs: 10_000 });
    const received: unknown[] = [];
    const url = `http://127.0.0.1:${address.port}/signal`;
    const bundle = await build({
      entryPoints: ["src/browser.ts"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      globalName: "BrowserTransport",
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen({
        host: "127.0.0.1",
        port: address.port,
        onRequest: (request) => {
          received.push(request.body);
          return { status: 201, headers: {}, body: request.body };
        },
      });
      browser = await chromium.launch({ executablePath, headless: true });
      const page = await browser.newPage();
      await page.route(`http://127.0.0.1:${address.port}/test`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>WebRTC test</title>",
        }),
      );
      await page.goto(`http://127.0.0.1:${address.port}/test`);
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      const signaling: { method: string; body: any; status: number; response?: any }[] = [];
      page.on("response", async (response) => {
        const request = response.request();
        if (!request.url().startsWith(url)) return;
        const item: (typeof signaling)[number] = {
          method: request.method(),
          body: request.postDataJSON(),
          status: response.status(),
        };
        signaling.push(item);
        if (item.method === "GET" && response.ok()) item.response = await response.json();
      });
      const result = await page.evaluate(async (peerUrl) => {
        const Transport = (window as any).BrowserTransport.WebRtcTransport;
        const client = new Transport({
          trickleIce: true,
          iceServers: [],
          iceGatheringTimeoutMs: 10_000,
          connectionTimeoutMs: 10_000,
        });
        try {
          const response = await client.execute({
            method: "POST",
            url: peerUrl,
            headers: {},
            protocol: "rest",
            body: "real Chromium trickle",
          });
          return { response, state: client.getSession(peerUrl)?.dataChannel.readyState };
        } finally {
          await client.close();
        }
      }, url);
      expect(result.state).toBe("open");
      expect(result.response).toMatchObject({ status: 201, body: "real Chromium trickle" });
      expect(received).toEqual(["real Chromium trickle"]);
      expect(
        signaling.some(
          (item) => item.method === "POST" && item.body?.trickle === true && item.status === 200,
        ),
      ).toBe(true);
      expect(
        signaling.some(
          (item) => item.method === "PATCH" && item.body?.candidate && item.status === 204,
        ),
      ).toBe(true);
      expect(
        signaling.some(
          (item) => item.method === "PATCH" && item.body?.candidate === null && item.status === 204,
        ),
      ).toBe(true);
      expect(
        signaling.some(
          (item) =>
            item.method === "GET" &&
            item.response?.candidates.some((candidate: unknown) => candidate !== null),
        ),
      ).toBe(true);
      expect(
        signaling.some((item) => item.method === "GET" && item.response?.candidates.includes(null)),
      ).toBe(true);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
  30_000,
);
