import { describe, expect, it } from 'vitest';
import { Lane, NO_FAULTS, RTO_MS } from './link.js';

/** A clock and timers that move only when told to. */
function harness(draws: number[] = []) {
  let now = 1000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const lane = new Lane(
    { now: () => now },
    {
      setTimeout(fn, ms) {
        timers.push({ at: now + ms, fn });
        return { cancel() {} };
      },
      setInterval() {
        throw new Error('unused');
      },
    },
    () => draws.shift() ?? 1, // 1 never counts as a loss
  );
  const got: Array<{ n: number; at: number }> = [];
  return {
    lane,
    got,
    send(n: number, faults = NO_FAULTS) {
      lane.deliver(faults, () => got.push({ n, at: now }));
    },
    /** Time passes, but the event loop is busy: no timer gets to run. */
    busy(ms: number) {
      now += ms;
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (next === undefined || next.at > until) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = until;
    },
  };
}

describe('Lane — one direction of a link, as TCP behaves under loss (D17)', () => {
  it('delivers at once, synchronously, with no faults and nothing queued', () => {
    const h = harness();
    h.send(1);
    expect(h.got).toEqual([{ n: 1, at: 1000 }]);
  });

  it('delays every frame by the latency', () => {
    const h = harness();
    h.send(1, { latencyMs: 150, lossRate: 0 });
    expect(h.got).toEqual([]);
    h.advance(150);
    expect(h.got).toEqual([{ n: 1, at: 1150 }]);
  });

  it('resends a lost frame after the RTO, doubling — and holds every frame behind it', () => {
    const faults = { latencyMs: 50, lossRate: 0.5 };
    // frame 1: lost twice, then through → 50 + 200 + 400; frame 2: through at once → still behind 1
    const h = harness([0.1, 0.1, 0.9, 0.9]);
    h.send(1, faults);
    h.advance(10);
    h.send(2, faults);
    h.advance(1000);
    expect(h.got).toEqual([
      { n: 1, at: 1000 + 50 + RTO_MS + 2 * RTO_MS },
      { n: 2, at: 1000 + 50 + RTO_MS + 2 * RTO_MS }, // head-of-line: never before frame 1
    ]);
  });

  it('never loses a frame, however lossy the link', () => {
    const h = harness(Array.from({ length: 1000 }, () => 0)); // every draw a loss
    for (let n = 0; n < 20; n += 1) h.send(n, { latencyMs: 0, lossRate: 0.9 });
    h.advance(60_000);
    expect(h.got.map((g) => g.n)).toEqual(Array.from({ length: 20 }, (_, n) => n));
  });

  it('never lets a frame overtake one whose timer is late — real timers are', () => {
    const h = harness();
    h.send(1, { latencyMs: 100, lossRate: 0 });
    h.busy(150); // frame 1 is due, but the loop has not got to its timer yet
    h.send(2); // no faults now, and its due moment has passed: it must still wait for frame 1
    h.advance(0);
    expect(h.got.map((g) => g.n)).toEqual([1, 2]);
  });

  it('a stall holds everything until it lifts, then delivers in order', () => {
    const h = harness();
    h.lane.stall(3000);
    h.send(1);
    h.advance(1000);
    h.send(2);
    expect(h.got).toEqual([]);
    h.advance(2000);
    expect(h.got).toEqual([
      { n: 1, at: 4000 },
      { n: 2, at: 4000 },
    ]);
    h.send(3);
    expect(h.got.at(-1)).toEqual({ n: 3, at: 4000 }); // lifted: synchronous again
  });
});
