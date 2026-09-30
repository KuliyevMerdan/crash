import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryStore } from './memory.js';
import { sqliteStore } from './sqlite.js';
import type { Store, StoredChain } from './store.js';

/**
 * One contract, two implementations: whatever the memory store promises, SQLite keeps — including
 * after the file is closed and reopened, which is the promise the whole store exists for.
 */
const dir = mkdtempSync(path.join(tmpdir(), 'crash-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `store-${++n}.db`);

const CHAIN: StoredChain = {
  id: 1,
  s0: 'ab'.repeat(32),
  salt: 'crash-demo-chain-1',
  length: 1000,
  houseEdgeBps: 100,
  commit: 'cd'.repeat(32),
  consumed: 0,
};

describe.each([
  ['memory', () => memoryStore()],
  ['sqlite', () => sqliteStore(file())],
])('the %s store', (_name, make: () => Store) => {
  it('adds chains, never replaces one, and moves the cursor forward only', () => {
    const store = make();
    store.addChain(CHAIN);
    expect(() => store.addChain(CHAIN)).toThrow();
    store.setConsumed(1, 1);
    store.setConsumed(1, 2);
    expect(() => store.setConsumed(1, 2)).toThrow();
    expect(() => store.setConsumed(1, 1)).toThrow();
    expect(store.chains()).toEqual([{ ...CHAIN, consumed: 2 }]);
  });

  it('keeps a journal since the checkpoint, and a checkpoint empties it', () => {
    const store = make();
    expect(store.readCheckpoint()).toBeNull();
    store.append({ now: 1, event: '{"a":1}' });
    store.append({ now: 2, event: '{"b":2}' });
    expect(store.readJournal()).toEqual([
      { now: 1, event: '{"a":1}' },
      { now: 2, event: '{"b":2}' },
    ]);
    store.writeCheckpoint('{"v":1}');
    expect(store.readJournal()).toEqual([]);
    store.writeCheckpoint('{"v":2}');
    expect(store.readCheckpoint()).toBe('{"v":2}');
  });

  it('rolls a failed transaction back entirely', () => {
    const store = make();
    store.addChain(CHAIN);
    expect(() =>
      store.transaction(() => {
        store.append({ now: 1, event: '{}' });
        store.setConsumed(1, 1);
        store.claimBetId('B1', 'p1');
        throw new Error('the step failed after writing');
      }),
    ).toThrow('the step failed');
    expect(store.readJournal()).toEqual([]);
    expect(store.chains()[0]?.consumed).toBe(0);
    expect(store.hasBetId('B1')).toBe(false);
  });

  it('serves a reveal only once written, and refuses to rewrite one', () => {
    const store = make();
    const reveal = {
      chainId: 1,
      chainIndex: 7,
      roundId: 'R',
      seed: 's',
      previousHash: 'p',
      crashPoint: 247,
    };
    expect(store.reveal(1, 7)).toBeNull();
    store.addReveal(reveal);
    expect(store.reveal(1, 7)).toEqual(reveal);
    expect(() => store.addReveal({ ...reveal, crashPoint: 5000 })).toThrow();
  });

  it('maps tokens to players, and claims each betId once', () => {
    const store = make();
    expect(store.playerForToken('t')).toBeNull();
    store.addSession('t', 'p1');
    expect(store.playerForToken('t')).toBe('p1');
    expect(store.claimBetId('B1', 'p1')).toBe(true);
    expect(store.claimBetId('B1', 'p2')).toBe(false);
    expect(store.hasBetId('B1')).toBe(true);
    expect(() => store.ping()).not.toThrow();
  });
});

describe('the sqlite store across a restart', () => {
  it('keeps everything after the file is closed and reopened', () => {
    const where = file();
    const first = sqliteStore(where);
    first.addChain(CHAIN);
    first.setConsumed(1, 5);
    first.writeCheckpoint('{"v":1}');
    first.append({ now: 9, event: '{"e":1}' });
    first.addSession('t', 'p1');
    first.claimBetId('B1', 'p1');
    first.close();

    const second = sqliteStore(where);
    expect(second.chains()).toEqual([{ ...CHAIN, consumed: 5 }]);
    expect(second.readCheckpoint()).toBe('{"v":1}');
    expect(second.readJournal()).toEqual([{ now: 9, event: '{"e":1}' }]);
    expect(second.playerForToken('t')).toBe('p1');
    expect(second.hasBetId('B1')).toBe(true);
    second.close();
  });
});
