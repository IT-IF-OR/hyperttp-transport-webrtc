import { afterEach, describe, expect, it, vi } from "vitest";
import { RtpPacer } from "../src/rtp-pacer.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RTP pacer", () => {
  it("paces direct 20 ms RTP packets arriving after 75, 5 and 20 ms", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const fail = vi.fn();
    const start = performance.now();
    const pacer = new RtpPacer<number>(() => sent.push(performance.now() - start), fail, vi.fn());

    pacer.push(0, 0);
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(75);
    pacer.push(1, 960);
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(5);
    pacer.push(2, 1920);
    vi.advanceTimersByTime(20);
    pacer.push(3, 2880);
    vi.advanceTimersByTime(20);

    expect(sent).toEqual([0, 75, 95, 115]);
    expect(fail).not.toHaveBeenCalled();
  });

  it("paces a modeled FFmpeg batch from 75, 5 and 20 ms PCM chunks", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const fail = vi.fn();
    const start = performance.now();
    const pacer = new RtpPacer<number>(() => sent.push(performance.now() - start), fail, vi.fn());
    let samples = 0;
    let timestamp = 0;
    // Model an encoder emitting all complete 20 ms frames when a PCM chunk arrives.
    const input = (duration: number) => {
      samples += duration * 48;
      while (samples >= 960) {
        pacer.push(timestamp, timestamp);
        timestamp += 960;
        samples -= 960;
      }
    };

    vi.advanceTimersByTime(75);
    input(75);
    vi.advanceTimersByTime(5);
    input(5);
    vi.advanceTimersByTime(20);
    input(20);
    vi.advanceTimersByTime(60);

    expect(sent).toEqual([75, 95, 115, 135, 155]);
    expect(fail).not.toHaveBeenCalled();
  });
  it("paces across timestamp wrap and does not burst after a pause", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const fail = vi.fn();
    const drained = vi.fn();
    const pacer = new RtpPacer<number>((n) => sent.push(n), fail, drained);
    pacer.push(1, 0xfffffc40);
    pacer.push(2, 0);
    vi.advanceTimersByTime(0);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(19);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([1, 2]);
    vi.advanceTimersByTime(1000);
    pacer.push(3, 960);
    vi.advanceTimersByTime(0);
    pacer.push(4, 1920);
    vi.advanceTimersByTime(19);
    expect(sent).toEqual([1, 2, 3]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([1, 2, 3, 4]);
    expect(fail).not.toHaveBeenCalled();
    expect(drained).toHaveBeenCalledTimes(3);
  });

  it("preserves phase despite repeated timer lateness", () => {
    vi.useFakeTimers();
    let lateness = 0;
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() + lateness);
    const sent: number[] = [];
    const fail = vi.fn();
    const pacer = new RtpPacer<number>(
      () => {
        lateness += 2;
        sent.push(performance.now());
      },
      fail,
      vi.fn(),
      200,
    );
    for (let i = 0; i < 100; i++) pacer.push(i, i * 960);
    vi.advanceTimersByTime(2000);
    expect(sent).toHaveLength(100);
    expect(sent[99]! - sent[0]!).toBeLessThan(1990);
    expect(fail).not.toHaveBeenCalled();
  });

  it("recovers gradually after a timer stall rather than bursting queued packets", () => {
    vi.useFakeTimers();
    let offset = 0;
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() + offset);
    const sent = vi.fn();
    const pacer = new RtpPacer(sent, vi.fn(), vi.fn());
    pacer.push(1, 0);
    pacer.push(2, 960);
    pacer.push(3, 1920);
    vi.advanceTimersByTime(0);
    offset = 1000;
    vi.advanceTimersByTime(20);
    expect(sent).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(17);
    expect(sent).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveBeenCalledTimes(3);
  });

  it("recovers from recurring stalls over 30 minutes without drops, bursts, or queue drift", () => {
    let now = 0;
    let timer: { at: number; callback: () => void } | undefined;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay = 0) => {
      timer = { at: now + Number(delay), callback };
      return 1;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {
      timer = undefined;
    });

    const fail = vi.fn();
    let sent = 0;
    let previousSend = -Infinity;
    let minimumSpacing = Infinity;
    let maxBacklog = 0;
    const pacer = new RtpPacer<number>(
      (packet) => {
        expect(packet).toBe(sent++);
        minimumSpacing = Math.min(minimumSpacing, now - previousSend);
        previousSend = now;
      },
      fail,
      vi.fn(),
    );
    const total = 90_000;
    let produced = 0;
    const runTimersThrough = (end: number) => {
      while (timer && timer.at <= end) {
        now = Math.max(now, timer.at);
        const callback = timer.callback;
        timer = undefined;
        callback();
      }
      now = end;
    };
    for (let t = 0; t < total * 20; t += 20) {
      // Model 120 ms event-loop stalls every 5 seconds: timers and UDP
      // callbacks are delayed, then all accumulated input arrives together.
      const stalled = t > 0 && t % 5000 === 0;
      if (stalled) now = t + 120;
      else runTimersThrough(Math.max(now, t));
      const through = stalled ? now : t;
      while (produced < total && produced * 20 <= through) {
        pacer.push(produced, (0xffff0000 + produced * 960) >>> 0);
        produced++;
      }
      maxBacklog = Math.max(maxBacklog, produced - sent);
      if (stalled) t += 120;
    }
    runTimersThrough(now + 5000);
    expect(fail).not.toHaveBeenCalled();
    expect(sent).toBe(total);
    expect(pacer.empty).toBe(true);
    expect(minimumSpacing).toBeGreaterThanOrEqual(18);
    expect(maxBacklog).toBeLessThan(20);
  });

  it("bounds the queue and cancels pending delivery on stop", () => {
    vi.useFakeTimers();
    const sent = vi.fn();
    const fail = vi.fn();
    const pacer = new RtpPacer(sent, fail, vi.fn(), 2);
    pacer.push(1, 0);
    pacer.push(2, 960);
    pacer.push(3, 1920);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: "PCM RTP pacing queue overflow" }),
    );
    pacer.stop();
    vi.runAllTimers();
    expect(sent).not.toHaveBeenCalled();
    expect(pacer.empty).toBe(true);
  });

  it("rejects backwards timestamps", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const pacer = new RtpPacer(vi.fn(), fail, vi.fn());
    pacer.push(1, 1000);
    vi.advanceTimersByTime(0);
    pacer.push(2, 999);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invalid PCM RTP timestamp discontinuity" }),
    );
  });
});
