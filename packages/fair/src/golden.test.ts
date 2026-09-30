import { describe, expect, it } from 'vitest';
import { createChain, crashPoint, previousHashOf, verifyToCommit } from './index.js';
import { GOLDEN, LINKS, OTHER_EDGES, SALT } from './__fixtures__/golden.js';

/**
 * The golden test (ROADMAP S1). These values were computed by an independent implementation —
 * Python's `hashlib`/`hmac` and integer arithmetic, not this package — so they pin correctness as
 * well as stability. A diff here is either a bug or a deliberate, documented break of every past
 * verification; there is no third kind.
 *
 * Seeds are `SHA256("crash-golden-<i>")`, the salt is `crash-golden`, the edge 100 bps.
 */

describe('golden crash points', () => {
  it.each(GOLDEN)('%s → %d', (seed, expected) => {
    expect(crashPoint(seed, SALT, 100)).toBe(expected);
  });

  it('includes an instant bust, so the 1.00× floor is pinned too', () => {
    expect(GOLDEN.some(([, point]) => point === 100)).toBe(true);
  });

  it.each(OTHER_EDGES)('%s at %d bps → %d', (seed, edge, expected) => {
    expect(crashPoint(seed, SALT, edge)).toBe(expected);
  });
});

describe('golden chain', () => {
  const s0 = LINKS[0] ?? '';
  const commit = LINKS[LINKS.length - 1] ?? '';

  it.each([1, 2, 3, 1000])('builds the same chain with checkpoints every %d', (every) => {
    const chain = createChain(s0, LINKS.length, { checkpointEvery: every });
    expect(chain.commit).toBe(commit);
    for (let j = 1; j < LINKS.length; j += 1) {
      expect(chain.seedAt(j)).toBe(LINKS[LINKS.length - 1 - j]);
    }
  });

  it('links every revealed seed to the one before it, back to the commit', () => {
    for (let j = 1; j < LINKS.length; j += 1) {
      const seed = LINKS[LINKS.length - 1 - j] ?? '';
      expect(previousHashOf(seed)).toBe(LINKS[LINKS.length - j]);
      expect(verifyToCommit(seed, j, commit)).toBe(true);
    }
  });
});
