import type { JournalEntry, RevealRecord, Store, StoredChain } from './store.js';

interface Data {
  chains: Map<number, StoredChain>;
  checkpoint: string | null;
  journal: JournalEntry[];
  reveals: Map<string, RevealRecord>;
  sessions: Map<string, string>;
  betIds: Map<string, string>;
}

const copy = (d: Data): Data => ({
  chains: new Map(d.chains),
  checkpoint: d.checkpoint,
  journal: [...d.journal],
  reveals: new Map(d.reveals),
  sessions: new Map(d.sessions),
  betIds: new Map(d.betIds),
});

/** The in-memory twin. A transaction that throws is rolled back, as SQLite's would be. */
export function memoryStore(): Store {
  let data: Data = {
    chains: new Map(),
    checkpoint: null,
    journal: [],
    reveals: new Map(),
    sessions: new Map(),
    betIds: new Map(),
  };
  let depth = 0;

  return {
    transaction(fn) {
      if (depth > 0) return fn();
      const before = copy(data);
      depth += 1;
      try {
        return fn();
      } catch (error) {
        data = before;
        throw error;
      } finally {
        depth -= 1;
      }
    },
    chains: () => [...data.chains.values()].sort((a, b) => a.id - b.id),
    addChain(chain) {
      if (data.chains.has(chain.id)) throw new Error(`chain ${chain.id} already exists`);
      data.chains.set(chain.id, chain);
    },
    setConsumed(chainId, chainIndex) {
      const chain = data.chains.get(chainId);
      if (chain === undefined) throw new Error(`no chain ${chainId}`);
      if (chainIndex <= chain.consumed) {
        throw new Error(`chain ${chainId} index ${chainIndex} is already consumed`);
      }
      data.chains.set(chainId, { ...chain, consumed: chainIndex });
    },
    readCheckpoint: () => data.checkpoint,
    readJournal: () => [...data.journal],
    append(entry) {
      data.journal.push(entry);
    },
    writeCheckpoint(snapshot) {
      data.checkpoint = snapshot;
      data.journal = [];
    },
    addReveal(reveal) {
      const key = `${reveal.chainId}:${reveal.chainIndex}`;
      if (data.reveals.has(key)) throw new Error(`round ${key} is already revealed`);
      data.reveals.set(key, reveal);
    },
    reveal: (chainId, chainIndex) => data.reveals.get(`${chainId}:${chainIndex}`) ?? null,
    playerForToken: (token) => data.sessions.get(token) ?? null,
    addSession(token, playerId) {
      data.sessions.set(token, playerId);
    },
    claimBetId(betId, playerId) {
      if (data.betIds.has(betId)) return false;
      data.betIds.set(betId, playerId);
      return true;
    },
    hasBetId: (betId) => data.betIds.has(betId),
    ping() {},
    close() {},
  };
}
