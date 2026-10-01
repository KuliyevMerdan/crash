import { describe, expect, it } from 'vitest';
import {
  MAX_CRASH_POINT,
  bytesToHex,
  crashPoint,
  crashPointFromBits,
  crashPointTrace,
  hexToBytes,
  hmacSha256,
  utf8,
} from './index.js';

const TWO_52 = 2n ** 52n;

describe('crashPointFromBits — the formula at its edges', () => {
  it('busts instantly for the lowest draws: X < E', () => {
    expect(crashPointFromBits(0n, 100)).toBe(100); // 0.99× before the floor
    // X just under 1%: still 0.99…× before the floor.
    expect(crashPointFromBits(TWO_52 / 100n - 1n, 100)).toBe(100);
  });

  it('leaves the instant-bust region at exactly X = E', () => {
    // (1 − 0.01) / (1 − 0.01) = 1.00× — the first draw that is not a bust by the floor alone.
    const r = TWO_52 / 100n + 1n;
    expect(crashPointFromBits(r, 100)).toBe(100);
    expect(crashPointFromBits(TWO_52 / 2n, 100)).toBe(198); // X = ½ → 0.99 / 0.5 = 1.98×
  });

  it('reaches the ceiling for the highest draws, and never passes it', () => {
    expect(crashPointFromBits(TWO_52 - 1n, 100)).toBe(MAX_CRASH_POINT);
    expect(crashPointFromBits(TWO_52 - 50n, 0)).toBe(MAX_CRASH_POINT);
  });

  it('with no edge, never busts below 1.00× and pays X = 0 at exactly 1.00×', () => {
    expect(crashPointFromBits(0n, 0)).toBe(100);
    expect(crashPointFromBits(TWO_52 / 2n, 0)).toBe(200);
  });

  it('is monotonic in r: a higher draw never crashes earlier', () => {
    let previous = 0;
    for (let i = 0n; i < 4096n; i += 1n) {
      const point = crashPointFromBits((TWO_52 * i) / 4096n, 100);
      expect(point).toBeGreaterThanOrEqual(previous);
      previous = point;
    }
  });

  it.each([
    [-1n, 100],
    [TWO_52, 100],
    [0n, -1],
    [0n, 10_000],
    [0n, 1.5],
  ])('refuses r = %s at %d bps', (r, edge) => {
    expect(() => crashPointFromBits(r, edge)).toThrow(RangeError);
  });
});

describe('crashPoint', () => {
  it.each(['', 'abc', 'A'.repeat(64), 'g'.repeat(64)])('refuses the seed %j', (seed) => {
    expect(() => crashPoint(seed, 'salt', 100)).toThrow(RangeError);
  });

  it('depends on the salt', () => {
    const seed = 'ab'.repeat(32);
    expect(crashPoint(seed, 'one', 100)).not.toBe(crashPoint(seed, 'two', 100));
  });
});

describe('crashPointTrace — the working the verification page shows', () => {
  it('is crashPoint, with the HMAC and the 52 bits it read', () => {
    for (let i = 0; i < 50; i += 1) {
      const seed = bytesToHex(new Uint8Array(32).fill(i * 5 + 1));
      const trace = crashPointTrace(seed, 'crash-demo-chain-1', 100);
      expect(trace.crashPoint).toBe(crashPoint(seed, 'crash-demo-chain-1', 100));
      expect(trace.hmac).toBe(bytesToHex(hmacSha256(hexToBytes(seed), utf8('crash-demo-chain-1'))));
      expect(trace.r).toBe(BigInt(`0x${trace.hmac.slice(0, 13)}`));
      expect(trace.crashPoint).toBe(crashPointFromBits(trace.r, 100));
    }
  });
});
