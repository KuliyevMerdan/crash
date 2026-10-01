import { verifyLink, verifyToCommit } from '@crash/fair';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { ChainBook } from './chains.js';
import { memoryStore } from './store/memory.js';

const log = pino({ level: 'silent' });
const config = {
  length: 30,
  rotateAt: 10,
  saltPrefix: 'test-chain-',
  devSeed: 'ee'.repeat(32),
  firstId: 1,
};

describe('the chain book', () => {
  it('generates chain 1 once, from the dev seed, and never again', () => {
    const store = memoryStore();
    ChainBook.open(store, config, 100, log);
    const commit = store.chains()[0]?.commit;
    ChainBook.open(store, { ...config, devSeed: '11'.repeat(32) }, 100, log);
    expect(store.chains()).toHaveLength(1);
    expect(store.chains()[0]?.commit).toBe(commit);
  });

  it('names a fresh store’s first chain as told, and numbers the next one after it', () => {
    const store = memoryStore();
    const book = ChainBook.open(store, config, 100, log, 1_790_000_000);
    expect(book.info()).toMatchObject({ id: 1_790_000_000, salt: 'test-chain-1790000000' });
    for (let j = 1; j <= 29; j += 1) {
      store.setConsumed(book.next().chain.id, j);
      book.rotateIfDue();
    }
    expect(store.chains().map((c) => c.id)).toEqual([1_790_000_000, 1_790_000_001]);
    // A store that already has its chain keeps it, whatever the boot says.
    ChainBook.open(store, config, 100, log, 5);
    expect(store.chains().map((c) => c.id)).toEqual([1_790_000_000, 1_790_000_001]);
  });

  it('hands out links in order, each linking to the one before and back to the commit', () => {
    const store = memoryStore();
    const book = ChainBook.open(store, config, 100, log);
    const commit = book.info().commit;
    let previous = commit;
    for (let j = 1; j <= 5; j += 1) {
      const link = book.next();
      expect(link.chainIndex).toBe(j);
      expect(link.previousHash).toBe(previous);
      expect(verifyLink(link.seed, link.previousHash)).toBe(true);
      expect(verifyToCommit(link.seed, j, commit)).toBe(true);
      store.setConsumed(1, j);
      previous = link.seed;
    }
  });

  it('publishes the next chain with rotateAt rounds left, and moves to it at the end', () => {
    const store = memoryStore();
    const book = ChainBook.open(store, config, 100, log);
    for (let j = 1; j <= 29; j += 1) {
      store.setConsumed(book.next().chain.id, j);
      book.rotateIfDue();
      const chains = book.listing();
      expect(chains).toHaveLength(29 - j <= 10 ? 2 : 1);
    }
    const first = book.next();
    const second = book.listing()[1];
    expect(first).toMatchObject({
      chain: { id: 2, salt: 'test-chain-2' },
      chainIndex: 1,
      previousHash: second?.commit,
    });
    expect(book.info().id).toBe(2);
  });

  it('refuses to run on a chain whose s₀ no longer produces its published commit', () => {
    const store = memoryStore();
    ChainBook.open(store, config, 100, log);
    const tampered = memoryStore();
    const [chain] = store.chains();
    if (chain === undefined) throw new Error('no chain');
    tampered.addChain({ ...chain, s0: '00'.repeat(32) });
    expect(() => ChainBook.open(tampered, config, 100, log)).toThrow(
      /does not produce the published commit/,
    );
  });
});
