import { MAX_MULTIPLIER as CURVE_MAX, MIN_MULTIPLIER } from '@crash/curve';
import { MAX_CRASH_POINT, MIN_CRASH_POINT } from '@crash/fair';
import { MAX_MULTIPLIER as PROTOCOL_MAX, multiplier } from '@crash/protocol';
import { describe, expect, it } from 'vitest';

/**
 * The multiplier's range is defined three times, because `curve`, `fair` and `protocol` may not
 * import one another (CLAUDE.md § Dependency rules). This is what keeps three definitions one.
 * If they drifted, the server could schedule a bust the curve never reaches, or send a crash point
 * the client's own schema refuses.
 */
describe('the multiplier range agrees everywhere it is defined', () => {
  it('has one ceiling', () => {
    expect(new Set([CURVE_MAX, MAX_CRASH_POINT, PROTOCOL_MAX]).size).toBe(1);
  });

  it('has one floor', () => {
    expect(MIN_MULTIPLIER).toBe(MIN_CRASH_POINT);
    expect(multiplier.safeParse(MIN_MULTIPLIER - 1).success).toBe(false);
    expect(multiplier.safeParse(MIN_MULTIPLIER).success).toBe(true);
  });

  it('keeps the ceiling a safe integer, and the largest payout too', () => {
    expect(Number.isSafeInteger(CURVE_MAX * 50_000)).toBe(true);
  });
});
