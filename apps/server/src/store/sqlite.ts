import Database from 'better-sqlite3';
import { z } from 'zod';
import type { JournalEntry, RevealRecord, Store, StoredChain } from './store.js';

/**
 * Migrations, in order. `PRAGMA user_version` records how many have run; each runs once, in a
 * transaction. Append only — an edited migration is a database that disagrees with its history.
 */
const MIGRATIONS = [
  `
  CREATE TABLE chains (
    id             INTEGER PRIMARY KEY,
    s0             TEXT    NOT NULL,
    salt           TEXT    NOT NULL,
    length         INTEGER NOT NULL,
    house_edge_bps INTEGER NOT NULL,
    commit_hash    TEXT    NOT NULL UNIQUE,
    consumed       INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE journal (
    seq   INTEGER PRIMARY KEY AUTOINCREMENT,
    now   INTEGER NOT NULL,
    event TEXT    NOT NULL
  );
  CREATE TABLE checkpoint (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot TEXT NOT NULL
  );
  CREATE TABLE reveals (
    chain_id      INTEGER NOT NULL,
    chain_index   INTEGER NOT NULL,
    round_id      TEXT    NOT NULL,
    seed          TEXT    NOT NULL,
    previous_hash TEXT    NOT NULL,
    crash_point   INTEGER NOT NULL,
    PRIMARY KEY (chain_id, chain_index)
  );
  CREATE TABLE sessions (
    token     TEXT PRIMARY KEY,
    player_id TEXT NOT NULL
  );
  CREATE TABLE bet_ids (
    bet_id    TEXT PRIMARY KEY,
    player_id TEXT NOT NULL
  );
  `,
];

const chainRow = z.object({
  id: z.int(),
  s0: z.string(),
  salt: z.string(),
  length: z.int(),
  house_edge_bps: z.int(),
  commit_hash: z.string(),
  consumed: z.int(),
});

const revealRow = z.object({
  chain_id: z.int(),
  chain_index: z.int(),
  round_id: z.string(),
  seed: z.string(),
  previous_hash: z.string(),
  crash_point: z.int(),
});

const journalRow = z.object({ now: z.int(), event: z.string() });
const snapshotRow = z.object({ snapshot: z.string() });
const playerRow = z.object({ player_id: z.string() });

/**
 * SQLite through better-sqlite3 — synchronous, which is the point: the server computes a step,
 * writes it, and only then publishes it, with no await in between for another event to slip into.
 * WAL with `synchronous = FULL`: a committed step is on disk before its effects reach a socket.
 */
export function sqliteStore(path: string): Store {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  const version = z.int().parse(db.pragma('user_version', { simple: true }));
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i] ?? '');
      db.pragma(`user_version = ${i + 1}`);
    })();
  }

  const q = {
    chains: db.prepare('SELECT * FROM chains ORDER BY id'),
    addChain: db.prepare(
      `INSERT INTO chains (id, s0, salt, length, house_edge_bps, commit_hash, consumed)
       VALUES (@id, @s0, @salt, @length, @houseEdgeBps, @commit, @consumed)`,
    ),
    setConsumed: db.prepare('UPDATE chains SET consumed = ? WHERE id = ? AND consumed < ?'),
    readCheckpoint: db.prepare('SELECT snapshot FROM checkpoint WHERE id = 1'),
    readJournal: db.prepare('SELECT now, event FROM journal ORDER BY seq'),
    append: db.prepare('INSERT INTO journal (now, event) VALUES (?, ?)'),
    writeCheckpoint: db.prepare(
      'INSERT INTO checkpoint (id, snapshot) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot',
    ),
    clearJournal: db.prepare('DELETE FROM journal'),
    addReveal: db.prepare(
      `INSERT INTO reveals (chain_id, chain_index, round_id, seed, previous_hash, crash_point)
       VALUES (@chainId, @chainIndex, @roundId, @seed, @previousHash, @crashPoint)`,
    ),
    reveal: db.prepare('SELECT * FROM reveals WHERE chain_id = ? AND chain_index = ?'),
    playerForToken: db.prepare('SELECT player_id FROM sessions WHERE token = ?'),
    addSession: db.prepare('INSERT INTO sessions (token, player_id) VALUES (?, ?)'),
    claimBetId: db.prepare('INSERT OR IGNORE INTO bet_ids (bet_id, player_id) VALUES (?, ?)'),
    hasBetId: db.prepare('SELECT 1 FROM bet_ids WHERE bet_id = ?'),
    ping: db.prepare('SELECT 1'),
  };

  const toChain = (row: unknown): StoredChain => {
    const r = chainRow.parse(row);
    return {
      id: r.id,
      s0: r.s0,
      salt: r.salt,
      length: r.length,
      houseEdgeBps: r.house_edge_bps,
      commit: r.commit_hash,
      consumed: r.consumed,
    };
  };

  return {
    transaction: (fn) => db.transaction(fn)(),
    chains: () => q.chains.all().map(toChain),
    addChain(chain) {
      q.addChain.run(chain);
    },
    setConsumed(chainId, chainIndex) {
      if (q.setConsumed.run(chainIndex, chainId, chainIndex).changes !== 1) {
        throw new Error(
          `chain ${chainId} index ${chainIndex} is already consumed, or no such chain`,
        );
      }
    },
    readCheckpoint() {
      const row = q.readCheckpoint.get();
      return row === undefined ? null : snapshotRow.parse(row).snapshot;
    },
    readJournal: (): JournalEntry[] => q.readJournal.all().map((row) => journalRow.parse(row)),
    append(entry) {
      q.append.run(entry.now, entry.event);
    },
    writeCheckpoint(snapshot) {
      q.writeCheckpoint.run(snapshot);
      q.clearJournal.run();
    },
    addReveal(reveal) {
      q.addReveal.run(reveal);
    },
    reveal(chainId, chainIndex): RevealRecord | null {
      const row = q.reveal.get(chainId, chainIndex);
      if (row === undefined) return null;
      const r = revealRow.parse(row);
      return {
        chainId: r.chain_id,
        chainIndex: r.chain_index,
        roundId: r.round_id,
        seed: r.seed,
        previousHash: r.previous_hash,
        crashPoint: r.crash_point,
      };
    },
    playerForToken(token) {
      const row = q.playerForToken.get(token);
      return row === undefined ? null : playerRow.parse(row).player_id;
    },
    addSession(token, playerId) {
      q.addSession.run(token, playerId);
    },
    claimBetId: (betId, playerId) => q.claimBetId.run(betId, playerId).changes === 1,
    hasBetId: (betId) => q.hasBetId.get(betId) !== undefined,
    ping() {
      q.ping.get();
    },
    close() {
      db.close();
    },
  };
}
