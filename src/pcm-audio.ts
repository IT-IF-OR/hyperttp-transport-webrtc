import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { MediaStream, MediaStreamTrack, RtpPacket } from "werift";

export interface PcmAudioSubscription {
  stream: MediaStream;
  close(): void;
}

export interface PcmAudioSource {
  subscribe(): PcmAudioSubscription;
  close(): Promise<void>;
  /** Resolves on EOF or explicit close; rejects on input, socket, or encoder failure. */
  done: Promise<void>;
}

export interface PcmAudioOptions {
  ffmpegPath?: string;
  signal?: AbortSignal;
}

/**
 * Optional server-only helper. Requires an external FFmpeg executable with libopus
 * on PATH (or ffmpegPath). Input is raw 48 kHz, stereo, signed 16-bit little-endian
 * PCM; chunk boundaries need not align to samples. One input/encoder is shared,
 * paced by FFmpeg's -re, with no replay for late subscribers. RTP/RTCP stays on
 * IPv4 loopback. No peer connection or native wrtc dependency is created.
 *
 * Writes are bounded to 16 KiB, with one outstanding write and one input chunk.
 * Producers must bound their own chunks/queues. Closing requests iterator.return()
 * or reader.cancel(); arbitrary iterators must cooperate to release their resources
 * (a stuck next()/return() does not prevent this helper from closing).
 */
export async function createPcmAudioSource(
  input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  options: PcmAudioOptions = {},
): Promise<PcmAudioSource> {
  options.signal?.throwIfAborted();
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => {
        socket.removeListener("error", reject);
        resolve();
      });
    });
    options.signal?.throwIfAborted();
  } catch (error) {
    try {
      socket.close();
    } catch {
      /* Bind may not have succeeded. */
    }
    throw error;
  }

  const port = socket.address().port;
  const child = spawn(
    options.ffmpegPath ?? "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-re",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-frame_duration",
      "20",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-payload_type",
      "111",
      "-f",
      "rtp",
      `rtp://127.0.0.1:${port}?rtcpport=${port}&pkt_size=1200`,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );

  const tracks = new Set<MediaStreamTrack>();
  let stopped = false;
  let inputEnded = false;
  let stderr = "";
  let cancelInput: (() => unknown) | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Callers may observe done later, or only call close().
  void done.catch(() => {});
  const pending = new Set<() => void>();
  function interruptible<T>(operation: PromiseLike<T>): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const cancel = () => resolve(undefined);
      pending.add(cancel);
      void Promise.resolve(operation).then(
        (value) => {
          pending.delete(cancel);
          resolve(value);
        },
        (error) => {
          pending.delete(cancel);
          reject(error);
        },
      );
      if (stopped) {
        pending.delete(cancel);
        cancel();
      }
    });
  }
  const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let cleanup: Promise<void> | undefined;

  function finish(error?: unknown): Promise<void> {
    if (cleanup) return cleanup;
    stopped = true;
    for (const cancel of pending) cancel();
    pending.clear();
    options.signal?.removeEventListener("abort", onAbort);
    // Do not wait for a user iterator that ignores cancellation.
    try {
      void Promise.resolve(cancelInput?.()).catch(() => {});
    } catch {
      /* Best effort. */
    }
    for (const track of tracks) track.stop();
    tracks.clear();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    cleanup = (async () => {
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1_000);
      try {
        await Promise.all([
          childClosed,
          new Promise<void>((resolve) => socket.close(() => resolve())),
        ]);
      } finally {
        clearTimeout(killTimer);
      }
    })();
    void cleanup.then(() => (error === undefined ? resolveDone() : rejectDone(error)), rejectDone);
    return cleanup;
  }

  function onAbort() {
    void finish(options.signal?.reason ?? new Error("PCM audio source aborted"));
  }
  socket.on("error", (error) => {
    void finish(error);
  });
  child.stdin.on("error", (error) => {
    if (!stopped) void finish(error);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8_192);
  });
  child.on("error", (error) => {
    void finish(error);
  });
  child.on("close", (code, signal) => {
    if (stopped) return;
    if (code === 0 && inputEnded) void finish();
    else void finish(new Error(`FFmpeg exited (${signal ?? code}): ${stderr.trim()}`));
  });
  socket.on("message", (message, remote) => {
    if (stopped || remote.address !== "127.0.0.1" || message.length < 12) return;
    // Reject RTCP and malformed/non-RTP datagrams before parsing.
    if (message[0]! >>> 6 !== 2 || (message[1]! & 0x7f) !== 111) return;
    let packet: RtpPacket;
    try {
      packet = RtpPacket.deSerialize(message);
    } catch {
      return;
    }
    if (packet.header.payloadType !== 111) return;
    for (const track of tracks) {
      if (!track.stopped) track.writeRtp(packet);
    }
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  // Surface executable startup failures from the factory, not just done.
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (stopped) {
      await done;
      throw new Error("PCM audio source closed during startup");
    }
  } catch (error) {
    await finish(error);
    throw error;
  }

  async function pump() {
    let release: (() => void) | undefined;
    try {
      let iterator: AsyncIterator<Uint8Array>;
      if ("getReader" in input) {
        const reader = input.getReader();
        iterator = { next: () => reader.read() };
        cancelInput = () => reader.cancel();
        release = () => reader.releaseLock();
      } else {
        iterator = input[Symbol.asyncIterator]();
        cancelInput = () => iterator.return?.();
      }
      let bytes = 0;
      while (!stopped) {
        const result = await interruptible(iterator.next());
        if (!result || stopped) return;
        if (result.done) {
          if (bytes % 4 !== 0)
            throw new Error("PCM input ends with an incomplete stereo s16le sample");
          inputEnded = true;
          child.stdin.end();
          return;
        }
        if (!(result.value instanceof Uint8Array))
          throw new TypeError("PCM chunks must be Uint8Array");
        const chunk = result.value;
        bytes = (bytes + chunk.byteLength) % 4;
        for (let offset = 0; offset < chunk.byteLength && !stopped; offset += 16_384) {
          await interruptible(
            new Promise<void>((resolve, reject) => {
              child.stdin.write(chunk.subarray(offset, offset + 16_384), (error) =>
                error ? reject(error) : resolve(),
              );
            }),
          );
        }
      }
    } catch (error) {
      if (!stopped) void finish(error);
    } finally {
      // A cancelled read may still be pending on a non-cooperative stream.
      try {
        release?.();
      } catch {
        /* Cancellation owns the pending read. */
      }
    }
  }
  void pump();

  return {
    done,
    subscribe() {
      if (stopped) throw new Error("PCM audio source is closed");
      const track = new MediaStreamTrack({ kind: "audio" });
      const stream = new MediaStream();
      stream.addTrack(track);
      tracks.add(track);
      return {
        stream,
        close() {
          tracks.delete(track);
          track.stop();
        },
      };
    },
    close: () => finish(),
  };
}
