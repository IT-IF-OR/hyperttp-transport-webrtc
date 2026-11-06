import { MediaStream } from "werift";
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
export declare function createPcmAudioSource(input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, options?: PcmAudioOptions): Promise<PcmAudioSource>;
//# sourceMappingURL=pcm-audio.d.ts.map