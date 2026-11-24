/** Bounded, monotonic RTP playout scheduler for a single 48 kHz stream. */
export declare class RtpPacer<T> {
    private readonly send;
    private readonly fail;
    private readonly drained;
    private readonly maxPackets;
    private queue;
    private timer;
    private lastTimestamp;
    private lastDeadline;
    private lastSentAt;
    private closed;
    private wasDrained;
    constructor(send: (packet: T) => void, fail: (error: Error) => void, drained: () => void, maxPackets?: number);
    push(packet: T, timestamp: number): void;
    stop(): void;
    get empty(): boolean;
    private schedule;
}
//# sourceMappingURL=rtp-pacer.d.ts.map