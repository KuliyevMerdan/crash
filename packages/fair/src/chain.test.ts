import { describe, expect, it } from 'vitest';
import { chainRounds, createChain, previousHashOf, verifyLink, verifyToCommit } from './index.js';

const S0 = '00'.repeat(32);

describe('createChain', () => {
  const chain = createChain(S0, 5000, { checkpointEvery: 64 });

  it('consumes the chain in reverse: each seed hashes to the one revealed before it', () => {
    let previous = chain.commit;
    for (let j = 1; j < chain.length; j += 1) {
      const seed = chain.seedAt(j);
      expect(verifyLink(seed, previous)).toBe(true);
      previous = seed;
    }
    expect(previous).toBe(S0); // the last round reveals s₀ itself
  });

  it('does not depend on the checkpoint spacing', () => {
    const plain = createChain(S0, 5000, { checkpointEvery: 1 });
    for (const j of [1, 2, 63, 64, 65, 2500, 4999]) expect(chain.seedAt(j)).toBe(plain.seedAt(j));
    expect(plain.commit).toBe(chain.commit);
  });

  it.each([0, 5000, -1, 1.5])('refuses chainIndex %d', (j) => {
    expect(() => chain.seedAt(j)).toThrow(RangeError);
  });

  it.each([
    [S0, 1, 1000],
    [S0, 10, 0],
    ['nope', 10, 1000],
  ])('refuses s₀ %j, length %d, checkpoints every %d', (s0, length, every) => {
    expect(() => createChain(s0, length, { checkpointEvery: every })).toThrow(RangeError);
  });
});

describe('verification', () => {
  const chain = createChain(S0, 200);

  it('walks any seed back to the commit', () => {
    for (const j of [1, 2, 100, 199])
      expect(verifyToCommit(chain.seedAt(j), j, chain.commit)).toBe(true);
  });

  it('rejects a seed claimed at the wrong index', () => {
    expect(verifyToCommit(chain.seedAt(10), 11, chain.commit)).toBe(false);
    expect(verifyToCommit(chain.seedAt(10), 9, chain.commit)).toBe(false);
  });

  it('rejects a forged seed and a forged link', () => {
    const forged = 'ff'.repeat(32);
    expect(verifyToCommit(forged, 1, chain.commit)).toBe(false);
    expect(verifyLink(forged, chain.commit)).toBe(false);
    expect(verifyLink(chain.seedAt(2), chain.commit)).toBe(false); // skips a link
  });

  it('answers false, not a throw, for input a stranger pasted', () => {
    expect(verifyLink('not hex', chain.commit)).toBe(false);
    expect(verifyToCommit(chain.seedAt(1), 0, chain.commit)).toBe(false);
    expect(verifyToCommit(chain.seedAt(1), 1, 'SHA256:' + chain.commit)).toBe(false);
  });

  it('previousHashOf is one step down the chain', () => {
    expect(previousHashOf(chain.seedAt(1))).toBe(chain.commit);
  });
});

describe('chainRounds', () => {
  it('walks the same chain createChain builds, round by round, in consumption order', () => {
    const chain = createChain(S0, 700, { checkpointEvery: 50 });
    const walk = chainRounds(S0, 700);
    expect(walk.commit).toBe(chain.commit);
    const rounds = [...walk.rounds()];
    expect(rounds).toHaveLength(699);
    for (const round of rounds) {
      expect(round.seed).toBe(chain.seedAt(round.chainIndex));
      expect(verifyLink(round.seed, round.previousHash)).toBe(true);
    }
    expect(rounds[0]?.previousHash).toBe(chain.commit);
    expect(rounds[698]?.seed).toBe(S0);
  });

  it.each([1, 0, 2.5])('refuses a length of %d', (length) => {
    expect(() => chainRounds(S0, length)).toThrow(RangeError);
  });
});
