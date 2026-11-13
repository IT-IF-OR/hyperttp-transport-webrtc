import { createServer } from "node:net";
import type { TransportListenOptions, TransportRequest } from "@hyperttp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaStream, MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from "werift";
import { WebRtcTransport } from "../src/webrtc.js";
import { WebRtcTransport as BrowserWebRtcTransport } from "../src/browser.js";

const options = {
  iceServers: [],
  iceGatheringTimeoutMs: 10_000,
  signalingTimeoutMs: 10_000,
  connectionTimeoutMs: 8_000,
  requestTimeoutMs: 5_000,
};

// listen() does not expose its bound port, so release a temporary OS-assigned port first.
async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") throw new Error("No TCP port allocated");
  return address.port;
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}, 10_000);

async function startServer(
  onRequest: NonNullable<TransportListenOptions["onRequest"]>,
  localStream?: MediaStream,
): Promise<string> {
  const server = new WebRtcTransport({
    ...options,
    ...(localStream ? { localStream } : {}),
  });
  cleanup.push(() => server.close());
  const port = await allocatePort();
  await server.listen({ host: "127.0.0.1", port, onRequest });
  return `webrtc://127.0.0.1:${port}/signal`;
}

function request(url: string, body?: unknown): TransportRequest {
  return {
    method: "POST",
    url,
    headers: { "x-test": "webrtc" },
    protocol: "rest",
    body,
  };
}

function bandwidthEstimatorOf(peerConnection: unknown): string {
  return (peerConnection as { config: { bandwidthEstimator: string } }).config.bandwidthEstimator;
}

describe("built-in Werift sender queue", () => {
  it("uses GCC by default to enable Werift's bounded paced RTP queue", async () => {
    const url = await startServer(() => ({ status: 200, headers: {}, body: "ok" }));
    const client = new WebRtcTransport(options);
    cleanup.push(() => client.close());

    await client.execute(request(url));

    expect(bandwidthEstimatorOf(client.getSession(url)!.peerConnection)).toBe("gcc");
  }, 15_000);

  it("allows selecting Werift's legacy lightweight estimator explicitly", async () => {
    const url = await startServer(() => ({ status: 200, headers: {}, body: "ok" }));
    const client = new WebRtcTransport({ ...options, weriftBandwidthEstimator: "lightweight" });
    cleanup.push(() => client.close());

    await client.execute(request(url));

    expect(bandwidthEstimatorOf(client.getSession(url)!.peerConnection)).toBe("lightweight");
  }, 15_000);

  it("leaves a caller-provided peer factory in complete control", async () => {
    const url = await startServer(() => ({ status: 200, headers: {}, body: "ok" }));
    let receivedConfiguration: RTCConfiguration | undefined;
    const client = new WebRtcTransport({
      ...options,
      weriftBandwidthEstimator: "gcc",
      createPeerConnection(configuration) {
        receivedConfiguration = configuration;
        return new RTCPeerConnection({
          iceServers: [],
          bandwidthEstimator: "lightweight",
        });
      },
    });
    cleanup.push(() => client.close());

    await client.execute(request(url));

    expect(receivedConfiguration).toEqual({ iceServers: [] });
    expect(bandwidthEstimatorOf(client.getSession(url)!.peerConnection)).toBe("lightweight");
  }, 15_000);
});

const clients = [
  {
    name: "Werift client",
    create: () => new WebRtcTransport(options),
  },
  {
    name: "browser transport with injected Werift",
    create: () =>
      new BrowserWebRtcTransport({
        ...options,
        // Only adapt the injected types; all networking and media objects remain real Werift.
        createPeerConnection: () =>
          new RTCPeerConnection({ iceServers: [] }) as unknown as globalThis.RTCPeerConnection,
        createMediaStream: () => new MediaStream() as unknown as globalThis.MediaStream,
      }),
  },
];

for (const { name, create } of clients) {
  describe(name, () => {
    it.each([
      ["text", "hello WebRTC — localhost"],
      ["binary", new Uint8Array([0, 1, 127, 128, 254, 255])],
    ])(
      "round-trips a %s request and response over a real data channel",
      async (_kind, body) => {
        const received: TransportRequest[] = [];
        const url = await startServer((incoming) => {
          received.push(incoming);
          return {
            status: 201,
            statusText: "Created",
            headers: { "x-echo": "yes" },
            url: incoming.url,
            body: incoming.body,
          };
        });
        const client = create();
        cleanup.push(() => client.close());
        const response = await client.execute(request(url, body));

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          method: "POST",
          url,
          protocol: "rest",
          headers: { "x-test": "webrtc" },
          body,
        });
        expect(response).toMatchObject({
          status: 201,
          statusText: "Created",
          headers: { "x-echo": "yes" },
          url,
          body,
        });
        expect(client.getSession(url)?.dataChannel.readyState).toBe("open");
        if (body instanceof Uint8Array) {
          expect(received[0]?.body).toBeInstanceOf(Uint8Array);
          expect(response.body).toBeInstanceOf(Uint8Array);
        }
      },
      15_000,
    );

    it("receives a server-only audio track and RTP without a local stream", async () => {
      const source = new MediaStreamTrack({ kind: "audio", id: "server-audio" });
      cleanup.push(() => source.stop());
      const stream = new MediaStream([source]);
      const url = await startServer(() => ({ status: 200, headers: {}, body: "audio" }), stream);
      const client = create();
      cleanup.push(() => client.close());
      const tracks: MediaStreamTrack[] = [];
      const packets: RtpPacket[] = [];
      const unsubscribe = client.onTrack((event) => {
        const track = event.track as unknown as MediaStreamTrack;
        tracks.push(track);
        const subscription = track.onReceiveRtp.subscribe((packet) => packets.push(packet));
        cleanup.push(() => subscription.unSubscribe());
      });
      cleanup.push(unsubscribe);

      const response = await client.execute({ ...request(url), receiveAudio: true });
      expect(response.body).toBe("audio");
      await expect.poll(() => tracks.length, { timeout: 3_000 }).toBe(1);
      expect(tracks[0]?.kind).toBe("audio");
      const session = client.getSession(url);
      expect(session?.localStream).toBeUndefined();
      expect(session?.remoteStream.getAudioTracks()).toHaveLength(1);
      expect(session?.peerConnection.getTransceivers()[0]?.direction).toBe("recvonly");

      const payload = Buffer.from([0xf8, 0xff, 0xfe]); // Opus silence.
      let sequenceNumber = 0;
      const sendPacket = () => {
        source.writeRtp(
          new RtpPacket(
            new RtpHeader({
              payloadType: source.codec?.payloadType ?? 96,
              sequenceNumber: sequenceNumber++,
              timestamp: sequenceNumber * 960,
              ssrc: 12345,
            }),
            payload,
          ),
        );
      };
      const timer = setInterval(sendPacket, 20);
      try {
        sendPacket();
        await expect.poll(() => packets.length, { timeout: 4_000 }).toBeGreaterThan(0);
        expect(packets[0]?.payload).toEqual(payload);
      } finally {
        clearInterval(timer);
      }
    }, 15_000);

    if (name === "Werift client") {
      it("removes transport listeners from retained peer and channel without removing application listeners", async () => {
        const url = await startServer(() => ({ status: 200, headers: {}, body: "ok" }));
        const client = create();
        cleanup.push(() => client.close());
        await client.execute(request(url));
        const view = client.getSession(url)!;
        const peer = view.peerConnection;
        const channel = view.dataChannel;
        const peerRemove = vi.spyOn(peer, "removeEventListener");
        const channelRemove = vi.spyOn(channel, "removeEventListener");
        const applicationListener = vi.fn();
        channel.addEventListener("message", applicationListener);
        await client.close();
        expect(peerRemove.mock.calls.filter(([type]) => type === "track")).toHaveLength(2);
        expect(peerRemove).toHaveBeenCalledWith("connectionstatechange", expect.any(Function));
        for (const type of ["message", "close", "error"]) {
          expect(channelRemove).toHaveBeenCalledWith(type, expect.any(Function));
        }
        channel.dispatchEvent(new MessageEvent("message", { data: "application" }));
        expect(applicationListener).toHaveBeenCalledOnce();
      }, 15_000);

      it("releases the ended listener when a consumer retains a remote track", async () => {
        const source = new MediaStreamTrack({ kind: "audio", id: "retained-remote-track" });
        cleanup.push(() => source.stop());
        const url = await startServer(
          () => ({ status: 200, headers: {}, body: "audio" }),
          new MediaStream([source]),
        );
        const client = create();
        cleanup.push(() => client.close());
        let retainedTrack: MediaStreamTrack | undefined;
        let removedEndedListeners = 0;
        const unsubscribe = client.onTrack((event) => {
          retainedTrack = event.track as unknown as MediaStreamTrack;
          const removeEventListener = retainedTrack.removeEventListener.bind(retainedTrack);
          retainedTrack.removeEventListener = ((type, listener) => {
            if (type === "ended") removedEndedListeners++;
            removeEventListener(type, listener);
          }) as typeof retainedTrack.removeEventListener;
        });
        cleanup.push(unsubscribe);

        await client.execute({ ...request(url), receiveAudio: true });
        await expect.poll(() => retainedTrack).toBeDefined();
        await client.close();
        expect(removedEndedListeners).toBe(1);
        retainedTrack!.dispatchEvent(new Event("ended"));
      }, 15_000);
    }

    it("rejects execute after closing an established client", async () => {
      let requests = 0;
      const url = await startServer(() => {
        requests++;
        return { status: 200, headers: {}, body: "connected" };
      });
      const client = create();
      cleanup.push(() => client.close());
      await expect(client.execute(request(url))).resolves.toMatchObject({ body: "connected" });
      await client.close();

      expect(client.getSession(url)).toBeUndefined();
      await expect(client.execute(request(url))).rejects.toThrow(/closed/i);
      expect(requests).toBe(1);
    }, 15_000);
  });
}
