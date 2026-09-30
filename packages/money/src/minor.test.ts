import { describe, expect, it } from 'vitest';
import { add, compare, formatMinor, isMinor, minor, payout, sub, ZERO } from './index.js';

describe('minor', () => {
  it.each([0, 1, -1, 100_000, Number.MAX_SAFE_INTEGER])('accepts the safe integer %d', (n) => {
    expect(minor(n)).toBe(n);
  });

  it.each([0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses %d', (n) => {
    expect(isMinor(n)).toBe(false);
    expect(() => minor(n)).toThrow(RangeError);
  });

  it('adds, subtracts and compares exactly', () => {
    expect(add(minor(100_000), minor(-500))).toBe(99_500);
    expect(sub(minor(99_500), minor(500))).toBe(99_000);
    expect(compare(minor(1), minor(2))).toBe(-1);
    expect(compare(minor(2), minor(2))).toBe(0);
    expect(compare(ZERO, minor(-1))).toBe(1);
  });

  it('refuses a sum that leaves the safe range instead of rounding it', () => {
    expect(() => add(minor(Number.MAX_SAFE_INTEGER), minor(1))).toThrow(RangeError);
  });
});

describe('payout', () => {
  it.each([
    [500, 421, 2105], // the protocol's own example, docs/protocol.md §2.5
    [500, 100, 500], // 1.00× returns the stake
    [100, 247, 247],
    [333, 150, 499], // 499.5 floors — the house keeps the half
    [1, 199, 1],
    [50_000, 100_000, 50_000_000], // max bet at max auto cash-out
    [0, 5000, 0],
  ])('floor(%d × %d / 100) = %d', (stake, multiplier, expected) => {
    expect(payout(minor(stake), multiplier)).toBe(expected);
  });

  it('fits the largest bet at the crash-point ceiling', () => {
    expect(payout(minor(50_000), 100_000_000)).toBe(50_000_000_000);
  });

  it('refuses a product that is no longer an exact integer', () => {
    expect(() => payout(minor(Number.MAX_SAFE_INTEGER), 200)).toThrow(/overflows/);
  });

  it.each([
    [-1, 200],
    [100, 1.5],
    [100, -100],
  ])('refuses stake %d at multiplier %d', (stake, multiplier) => {
    expect(() => payout(minor(stake), multiplier)).toThrow(RangeError);
  });
});

describe('formatMinor', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [2105, '21.05'],
    [123_456_789, '1,234,567.89'],
    [-99_500, '-995.00'],
  ])('%d → %s in en-US', (amount, expected) => {
    expect(formatMinor(minor(amount), { locale: 'en-US' })).toBe(expected);
  });

  it('uses the locale for grouping and the decimal mark', () => {
    expect(formatMinor(minor(123_456_789), { locale: 'de-DE' })).toBe('1.234.567,89');
  });

  it('formats whole units when there is no fraction', () => {
    expect(formatMinor(minor(1500), { locale: 'en-US', fractionDigits: 0 })).toBe('1,500');
  });

  it('never rounds: an amount one unit short of a whole prints as such', () => {
    expect(formatMinor(minor(99_999), { locale: 'en-US' })).toBe('999.99');
  });
});
