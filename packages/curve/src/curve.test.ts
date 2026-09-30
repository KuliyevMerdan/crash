import { describe, expect, it } from 'vitest';
import {
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  curve,
  elapsedAt,
  multiplierAt,
  smoothMultiplierAt,
} from './index.js';

const K = curve(0.15); // the demo's curve, docs/protocol.md §2.2

/** A small seeded PRNG — the tests replay, like everything else here. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('multiplierAt', () => {
  it('starts every round at 1.00×, and reads 1.00× before the start', () => {
    expect(multiplierAt(K, 0)).toBe(MIN_MULTIPLIER);
    expect(multiplierAt(K, -250)).toBe(MIN_MULTIPLIER);
  });

  it("agrees with the protocol's tick example: m(3400) = 166", () => {
    expect(multiplierAt(K, 3400)).toBe(166);
  });

  it('never exceeds the ceiling, however long the round', () => {
    expect(multiplierAt(K, 92_104)).toBe(MAX_MULTIPLIER);
    expect(multiplierAt(K, 10_000_000)).toBe(MAX_MULTIPLIER);
    expect(multiplierAt(K, Number.MAX_VALUE)).toBe(MAX_MULTIPLIER);
  });

  it('never decreases, millisecond by millisecond, across the whole range', () => {
    let previous = multiplierAt(K, 0);
    for (let ms = 1; ms <= 93_000; ms += 1) {
      const current = multiplierAt(K, ms);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('floors fractional time the same way it floors integer time', () => {
    expect(multiplierAt(K, 4620.9)).toBe(199);
    expect(multiplierAt(K, 4621)).toBe(200);
  });

  it('refuses NaN rather than answer with it', () => {
    expect(() => multiplierAt(K, Number.NaN)).toThrow(RangeError);
  });
});

describe('elapsedAt — the exact inverse', () => {
  // Independently computed (Python, math.exp) — the reference the implementation must meet.
  it.each([
    [100, 0],
    [101, 67],
    [200, 4621],
    [1000, 15_351],
    [10_000, 30_702],
    [100_000, 46_052],
    [MAX_MULTIPLIER, 92_104],
  ])('%d hundredths is first reached at %d ms', (multiplier, ms) => {
    expect(elapsedAt(K, multiplier)).toBe(ms);
  });

  it('lands on the boundary for every step from 1.00× to 100.00×', () => {
    for (let x = MIN_MULTIPLIER; x <= 10_000; x += 1) {
      const ms = elapsedAt(K, x);
      expect(multiplierAt(K, ms)).toBeGreaterThanOrEqual(x);
      if (ms > 0) expect(multiplierAt(K, ms - 1)).toBeLessThan(x);
    }
  });

  it('lands on the boundary for random multipliers up to the ceiling, on several curves', () => {
    const random = lcg(20260930);
    for (const k of [0.05, 0.15, 0.4, 1.3]) {
      const c = curve(k);
      for (let i = 0; i < 2000; i += 1) {
        const x = MIN_MULTIPLIER + Math.floor(random() * (MAX_MULTIPLIER - MIN_MULTIPLIER + 1));
        const ms = elapsedAt(c, x);
        expect(multiplierAt(c, ms)).toBeGreaterThanOrEqual(x);
        if (ms > 0) expect(multiplierAt(c, ms - 1)).toBeLessThan(x);
      }
    }
  });

  it('round-trips: t(m(t)) ≤ t, and shows the same multiplier', () => {
    const random = lcg(7);
    for (let i = 0; i < 20_000; i += 1) {
      const t = Math.floor(random() * 95_000);
      const shown = multiplierAt(K, t);
      const back = elapsedAt(K, shown);
      expect(back).toBeLessThanOrEqual(t);
      expect(multiplierAt(K, back)).toBe(shown);
    }
  });

  it.each([99, 100.5, MAX_MULTIPLIER + 1, Number.NaN])('refuses %d', (x) => {
    expect(() => elapsedAt(K, x)).toThrow(RangeError);
  });
});

describe('curve', () => {
  it.each([0, -0.15, Number.NaN, Infinity])('refuses a growth rate of %d', (k) => {
    expect(() => curve(k)).toThrow(RangeError);
  });
});

describe('smoothMultiplierAt', () => {
  it('is the unfloored line the counter is the floor of', () => {
    for (const ms of [0, 1, 67, 3400, 4621, 30_702]) {
      expect(Math.floor(smoothMultiplierAt(K, ms))).toBe(multiplierAt(K, ms));
    }
  });

  it('shares the start and the ceiling', () => {
    expect(smoothMultiplierAt(K, -1)).toBe(MIN_MULTIPLIER);
    expect(smoothMultiplierAt(K, 1_000_000)).toBe(MAX_MULTIPLIER);
  });
});
