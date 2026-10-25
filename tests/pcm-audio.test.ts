import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaStreamTrack, RtpPacket } from "werift";
import { createPcmAudioSource, type PcmAudioSource } from "../src/pcm-audio.js";

const probe = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
const hasFfmpeg = probe.status === 0 && probe.stdout.includes("libopus");
const sources: PcmAudioSource[] = [];
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.close()));
});

async function source(
  input: Parameters<typeof createPcmAudioSource>[0],
  options?: Parameters<typeof createPcmAudioSource>[1],
) {
  const result = await createPcmAudioSource(input, options);
  sources.push(result);
  return result;
}

function packets(track: MediaStreamTrack, count: number): Promise<RtpPacket[]> {
  return new Promise((resolve, reject) => {
    const received: RtpPacket[] = [];
    const timer = setTimeout(() => {
      subscription.unSubscribe();
      reject(new Error(`Only received ${received.length}/${count} RTP packets`));
    }, 5_000);
    const subscription = track.onReceiveRtp.subscribe((packet) => {
      received.push(packet);
      if (received.length === count) {
        clearTimeout(timer);
        subscription.unSubscribe();
        resolve(received);
      }
    });
  });
}

function silence(frames: number): Uint8Array {
  return new Uint8Array(frames * 960 * 2 * 2);
}

it("rejects a pre-aborted source without consuming input", async () => {
  const controller = new AbortController();
  const error = new Error("already aborted");
  controller.abort(error);
  let consumed = false;
  await expect(
    createPcmAudioSource(
      {
        async *[Symbol.asyncIterator]() {
          consumed = true;
          yield silence(1);
        },
      },
      { signal: controller.signal },
    ),
  ).rejects.toBe(error);
  expect(consumed).toBe(false);
});

it("rejects missing FFmpeg executables without consuming input", async () => {
  let consumed = false;
  await expect(
    createPcmAudioSource(
      {
        async *[Symbol.asyncIterator]() {
          consumed = true;
          yield silence(1);
        },
      },
      { ffmpegPath: "/nonexistent/pcm-audio-ffmpeg" },
    ),
  ).rejects.toThrow();
  expect(consumed).toBe(false);
});

describe.skipIf(!hasFfmpeg)("PCM audio with real loopback FFmpeg/libopus", () => {
  it("consumes once, emits 20ms Opus RTP, and isolates subscriptions", async () => {
    let iterations = 0;
    const audio = await source({
      async *[Symbol.asyncIterator]() {
        iterations++;
        yield silence(80);
      },
    });
    const first = audio.subscribe();
    const second = audio.subscribe();
    const a = first.stream.getAudioTracks()[0]!;
    const b = second.stream.getAudioTracks()[0]!;
    expect(a).not.toBe(b);
    expect(first.stream.id).not.toBe(second.stream.id);
    const [left, right] = await Promise.all([packets(a, 5), packets(b, 5)]);
    expect(left.map((packet) => packet.serialize())).toEqual(
      right.map((packet) => packet.serialize()),
    );
    for (let i = 1; i < right.length; i++) {
      expect(right[i]!.header.payloadType).toBe(111);
      expect(right[i]!.payload.length).toBeGreaterThan(0);
      expect((right[i]!.header.timestamp - right[i - 1]!.header.timestamp) >>> 0).toBe(960);
    }
    first.close();
    first.close();
    expect(a.stopped).toBe(true);
    expect(b.stopped).toBe(false);
    await packets(b, 5);
    const late = audio.subscribe();
    await packets(late.stream.getAudioTracks()[0]!, 2);
    await audio.done;
    expect(iterations).toBe(1);
    expect(b.stopped).toBe(true);
    expect(late.stream.active).toBe(false);
    expect(() => audio.subscribe()).toThrow("closed");
  }, 10_000);

  it("accepts ReadableStream input with non-sample-aligned chunks and releases its lock", async () => {
    const pcm = silence(10);
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pcm.subarray(0, 3));
        controller.enqueue(pcm.subarray(3));
        controller.close();
      },
    });
    const audio = await source(input);
    await packets(audio.subscribe().stream.getAudioTracks()[0]!, 3);
    await audio.done;
    expect(input.locked).toBe(false);
  });

  it("cancels a pending stream read and closes idempotently", async () => {
    let cancelled = 0;
    const input = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    const audio = await source(input);
    const subscription = audio.subscribe();
    await Promise.all([audio.close(), audio.close()]);
    await audio.done;
    expect(cancelled).toBe(1);
    expect(input.locked).toBe(false);
    expect(subscription.stream.active).toBe(false);
  });

  it("requests iterator cancellation without waiting for a stuck next", async () => {
    let returned = 0;
    const audio = await source({
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          async return() {
            returned++;
            return { done: true, value: undefined };
          },
        };
      },
    });
    await audio.close();
    await audio.done;
    expect(returned).toBe(1);
  });

  it("rejects done on input errors and stops tracks", async () => {
    let fail!: (error: Error) => void;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        fail = (error) => controller.error(error);
      },
    });
    const audio = await source(input);
    const subscription = audio.subscribe();
    const failure = new Error("PCM producer failed");
    fail(failure);
    await expect(audio.done).rejects.toBe(failure);
    expect(subscription.stream.active).toBe(false);
    expect(input.locked).toBe(false);
    await audio.close();
  });

  it("rejects incomplete stereo samples", async () => {
    const audio = await source({
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(3);
      },
    });
    await expect(audio.done).rejects.toThrow("incomplete stereo");
  });

  it("reports encoder exits", async () => {
    // Node accepts the spawn but rejects FFmpeg arguments, simulating a failed encoder.
    const audio = await source(new ReadableStream<Uint8Array>(), { ffmpegPath: process.execPath });
    await expect(audio.done).rejects.toThrow("FFmpeg exited");
  });

  it("aborts with the signal reason and cancels input", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const audio = await source(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { signal: controller.signal },
    );
    const failure = new Error("stop audio");
    controller.abort(failure);
    await expect(audio.done).rejects.toBe(failure);
    expect(cancelled).toBe(true);
    await audio.close();
  });

  it("does not read ahead while a large chunk is backpressured", async () => {
    let reads = 0;
    const audio = await source({
      async *[Symbol.asyncIterator]() {
        reads++;
        yield silence(1_000);
        reads++;
        yield silence(1);
      },
    });
    await packets(audio.subscribe().stream.getAudioTracks()[0]!, 5);
    expect(reads).toBe(1);
    await audio.close();
  });
});
