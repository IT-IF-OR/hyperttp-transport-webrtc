import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { WebRtcTransport } from "../src/webrtc.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

it("does not leave its HTTP server listening when close races with listen", async () => {
  const transport = new WebRtcTransport({ iceServers: [], logger: () => {} });
  cleanup.push(() => transport.close());
  const port = await reservePort();

  const starting = transport.listen({ port, signaling: { path: "/signal" } });
  const closing = transport.close();

  await closing;

  const probe = createServer();
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  probe.listen(port, "127.0.0.1");
  await once(probe, "listening");
  expect(probe.listening).toBe(true);
  await expect(starting).rejects.toThrow("WebRTC transport is closed");
});
