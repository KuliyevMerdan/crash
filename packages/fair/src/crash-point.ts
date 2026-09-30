import { hexToBytes, bytesToHex, isHash, utf8 } from './bytes.js';
import { hmacSha256 } from './sha256.js';

/** `1.00×` — the instant bust. */
export const MIN_CRASH_POINT = 100;

/**
 * `1,000,000.00×` (docs/protocol.md §3.2, D10). Equal to `MAX_MULTIPLIER` in `@crash/curve` — the
 * packages may not import each other, so `tests/constants.test.ts` asserts they agree.
 */
export const MAX_CRASH_POINT = 100_000_000;

const TWO_POW_52 = 2n ** 52n;

/**
 * The crash point of a round, in hundredths of 1× (docs/protocol.md §3.2):
 *
 * ```
 * h = HMAC_SHA256(key = bytes(seed), message = utf8(salt))
 * r = the first 52 bits of h
 * crashPoint = min(MAX, max(100, floor((10000 − edgeBps) · 2^52 / (100 · (2^52 − r)))))
 * ```
 *
 * `P(crash ≥ m) = (1 − E) / m`, the instant busts are exactly the `E` fraction, and every cash-out
 * target returns `1 − E` in expectation. Integer arithmetic throughout — no float touches a number
 * that decides money.
 */
export function crashPoint(seed: string, salt: string, houseEdgeBps: number): number {
  if (!isHash(seed)) throw new RangeError('a seed is 64 lowercase hex characters');
  const h = bytesToHex(hmacSha256(hexToBytes(seed), utf8(salt)));
  return crashPointFromBits(BigInt(`0x${h.slice(0, 13)}`), houseEdgeBps);
}

/**
 * The formula on its own, from the 52 bits — exported so its edges (the instant bust, the ceiling)
 * are testable without searching for a seed that happens to produce them.
 */
export function crashPointFromBits(r: bigint, houseEdgeBps: number): number {
  if (r < 0n || r >= TWO_POW_52) throw new RangeError(`r must be in [0, 2^52): ${r}`);
  if (!Number.isInteger(houseEdgeBps) || houseEdgeBps < 0 || houseEdgeBps >= 10_000) {
    throw new RangeError(`houseEdgeBps must be an integer in [0, 10000): ${houseEdgeBps}`);
  }
  const raw = (BigInt(10_000 - houseEdgeBps) * TWO_POW_52) / (100n * (TWO_POW_52 - r));
  if (raw >= BigInt(MAX_CRASH_POINT)) return MAX_CRASH_POINT;
  return Math.max(MIN_CRASH_POINT, Number(raw));
}
