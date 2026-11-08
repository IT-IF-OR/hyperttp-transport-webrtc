/** Bounded, monotonic RTP playout scheduler for a single 48 kHz stream. */
export class RtpPacer<T> {
  private queue: { packet: T; timestamp: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastTimestamp: number | undefined;
  private lastDeadline = 0;
  private lastSentAt = 0;
  private closed = false;
  private wasDrained = false;

  constructor(
    private readonly send: (packet: T) => void,
    private readonly fail: (error: Error) => void,
    private readonly drained: () => void,
    private readonly maxPackets = 100,
  ) {}

  push(packet: T, timestamp: number): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxPackets) {
      this.fail(new Error("PCM RTP pacing queue overflow"));
      return;
    }
    this.queue.push({ packet, timestamp });
    this.schedule();
  }

  stop(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
  }

  get empty(): boolean {
    return this.queue.length === 0;
  }

  private schedule(): void {
    if (this.closed || this.timer !== undefined || this.queue.length === 0) return;
    const next = this.queue[0]!;
    // Signed modular difference accepts the normal 32-bit wrap, but rejects
    // backwards timestamps and discontinuities too large to schedule safely.
    const delta = this.lastTimestamp === undefined ? 0 : (next.timestamp - this.lastTimestamp) | 0;
    if (delta < 0 || delta > 480_000) {
      this.fail(new Error("Invalid PCM RTP timestamp discontinuity"));
      return;
    }
    const now = performance.now();
    const interval = delta / 48;
    let deadline = this.lastTimestamp === undefined ? now : this.lastDeadline + interval;
    // An idle stream has no backlog to recover. Reset its phase, but keep the
    // minimum spacing from the previous send when packets resume quickly.
    if (this.queue.length === 1 && this.timer === undefined && this.wasDrained && deadline < now) {
      deadline = now;
    }
    this.wasDrained = false;
    // Recover lost time gradually, at no more than 1/0.9 of the media rate.
    // Keep the original media deadline so repeated stalls do not accumulate.
    const earliest = this.lastTimestamp === undefined ? now : this.lastSentAt + interval * 0.9;
    const delay = Math.max(0, Math.ceil(Math.max(deadline, earliest) - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      const item = this.queue.shift()!;
      this.lastTimestamp = item.timestamp;
      this.lastDeadline = deadline;
      this.lastSentAt = performance.now();
      this.send(item.packet);
      if (this.closed) return;
      if (this.queue.length === 0) {
        this.wasDrained = true;
        this.drained();
      } else this.schedule();
    }, delay);
  }
}
