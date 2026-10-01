import { bytesToHex, hexToBytes, isHash } from './bytes.js';
import { sha256 } from './sha256.js';

/**
 * The hash chain (ADR-0001, docs/protocol.md §3.3).
 *
 * `s₀` is 32 random bytes; `sᵢ₊₁ = SHA256(sᵢ)` over the raw bytes; the commit is `s_{N−1}`; round
 * `j` (`1 ≤ j ≤ N − 1`) uses `s_{N−1−j}`. Each revealed seed hashes to the one revealed before it,
 * and `j` hashes walk any seed back to the commit.
 *
 * `s₀` comes from a CSPRNG in the server — randomness enters this package only as an argument.
 */

/** The seed revealed one round earlier, or the commit for round 1: `SHA256(seed)`. */
export function previousHashOf(seed: string): string {
  return bytesToHex(sha256(toSeedBytes(seed)));
}

/** One link: does `seed` hash to the seed revealed before it? */
export function verifyLink(seed: string, previousHash: string): boolean {
  return isHash(seed) && isHash(previousHash) && previousHashOf(seed) === previousHash;
}

/**
 * The whole way back: does hashing round `chainIndex`'s seed `chainIndex` times reach the commit?
 * This is what the verification page runs in the browser — a million hashes at the far end of a
 * chain, which is the price of not trusting anyone's word for it.
 */
export function verifyToCommit(seed: string, chainIndex: number, commit: string): boolean {
  if (!isHash(seed) || !isHash(commit)) return false;
  if (!Number.isSafeInteger(chainIndex) || chainIndex < 1) return false;
  return hashTimes(seed, chainIndex) === commit;
}

/**
 * `SHA256` applied `times` times over the raw bytes, as hex — one stretch of the walk back to the
 * commit. `hashTimes(hashTimes(s, a), b) = hashTimes(s, a + b)`, so a page can take a million
 * hashes in slices, yield to the browser between them, and still be running this loop.
 */
export function hashTimes(seed: string, times: number): string {
  if (!Number.isSafeInteger(times) || times < 0) {
    throw new RangeError(`times must be a non-negative integer: ${times}`);
  }
  let current = toSeedBytes(seed);
  for (let i = 0; i < times; i += 1) current = sha256(current);
  return bytesToHex(current);
}

export interface Chain {
  /** `s_{N−1}` — published before the chain's first round. */
  readonly commit: string;
  /** `N`. Rounds use indices `1 … N − 1`. */
  readonly length: number;
  /** The seed of round `chainIndex` — `s_{N−1−chainIndex}`. */
  seedAt(chainIndex: number): string;
}

export interface ChainOptions {
  /**
   * Keep every `checkpointEvery`-th link, so `seedAt` walks at most that many hashes instead of up
   * to `N`. Building the chain costs `N` hashes once either way.
   */
  readonly checkpointEvery?: number;
}

export function createChain(s0: string, length: number, options: ChainOptions = {}): Chain {
  if (!Number.isSafeInteger(length) || length < 2) {
    throw new RangeError(`a chain needs at least two links: ${length}`);
  }
  const every = options.checkpointEvery ?? 1000;
  if (!Number.isSafeInteger(every) || every < 1) {
    throw new RangeError(`checkpointEvery must be a positive integer: ${every}`);
  }

  const checkpoints: Uint8Array[] = [];
  let current = toSeedBytes(s0);
  for (let position = 0; position < length; position += 1) {
    if (position % every === 0) checkpoints.push(current);
    if (position < length - 1) current = sha256(current);
  }
  const commit = bytesToHex(current);

  return {
    commit,
    length,
    seedAt(chainIndex: number): string {
      if (!Number.isSafeInteger(chainIndex) || chainIndex < 1 || chainIndex > length - 1) {
        throw new RangeError(`chainIndex must be in [1, ${length - 1}]: ${chainIndex}`);
      }
      const position = length - 1 - chainIndex;
      const nearest = Math.floor(position / every);
      const start = checkpoints[nearest];
      if (start === undefined) throw new Error(`no checkpoint ${nearest}`); // unreachable by construction
      let link = start;
      for (let p = nearest * every; p < position; p += 1) link = sha256(link);
      return bytesToHex(link);
    },
  };
}

function toSeedBytes(seed: string): Uint8Array {
  if (!isHash(seed)) throw new RangeError('a seed is 64 lowercase hex characters');
  return hexToBytes(seed);
}

export interface ChainRound {
  readonly chainIndex: number;
  readonly seed: string;
  readonly previousHash: string;
}

/**
 * Every round of a chain, in the order rounds consume it — for walking a whole chain, as
 * `tools/sim` does. `seedAt` with checkpoints costs up to `checkpointEvery` hashes per call, which is
 * right for a server opening one round every few seconds and ruinous for a million in a row; this
 * keeps every link in one buffer (32 bytes each — 32 MB for a million) and hashes each exactly once.
 */
export function chainRounds(
  s0: string,
  length: number,
): { readonly commit: string; rounds(): IterableIterator<ChainRound> } {
  if (!Number.isSafeInteger(length) || length < 2) {
    throw new RangeError(`a chain needs at least two links: ${length}`);
  }
  const links = new Uint8Array(32 * length);
  links.set(toSeedBytes(s0), 0);
  for (let i = 1; i < length; i += 1) {
    links.set(sha256(links.subarray((i - 1) * 32, i * 32)), i * 32);
  }
  const at = (position: number) => bytesToHex(links.subarray(position * 32, position * 32 + 32));

  return {
    commit: at(length - 1),
    *rounds() {
      for (let chainIndex = 1; chainIndex < length; chainIndex += 1) {
        const position = length - 1 - chainIndex;
        yield { chainIndex, seed: at(position), previousHash: at(position + 1) };
      }
    },
  };
}
