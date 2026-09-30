/**
 * Persistence behind one port, with two implementations held to one contract (`store.contract.ts`):
 * in-memory for tests and a throwaway dev server, SQLite for anything that must survive a restart.
 *
 * What is stored is exactly what a restart needs and nothing the engine can recompute:
 *
 * - **the chains** — `s₀` and the consumed index. `s₀` *is* the chain; regenerating it would silently
 *   break every past verification (ADR-0001), so a chain is only ever added, never replaced;
 * - **the engine**, as a checkpoint taken after each crash plus a journal of the events since — the
 *   engine is pure, so replaying the journal onto the checkpoint rebuilds the round exactly, auto
 *   cash-outs and all;
 * - **reveals**, for `GET /fair/:chainId/:chainIndex`;
 * - **sessions** (token → player) and **every `betId` ever accepted**, which is what makes a `betId`
 *   single-use beyond the engine's one-round memory (docs/protocol.md §7).
 */

export interface StoredChain {
  readonly id: number;
  /** Secret. Never logged, never served — only the seeds it yields are, one at a time, after a crash. */
  readonly s0: string;
  readonly salt: string;
  readonly length: number;
  readonly houseEdgeBps: number;
  readonly commit: string;
  /** The highest chain index a round has used; `0` before the first. */
  readonly consumed: number;
}

export interface RevealRecord {
  readonly chainId: number;
  readonly chainIndex: number;
  readonly roundId: string;
  readonly seed: string;
  readonly previousHash: string;
  readonly crashPoint: number;
}

export interface JournalEntry {
  readonly now: number;
  /** An `EngineEvent`, as JSON — decoded by `codec.ts` on replay. */
  readonly event: string;
}

export interface Store {
  /** Runs `fn` atomically: everything it writes lands, or nothing does. */
  transaction<T>(fn: () => T): T;

  chains(): StoredChain[];
  addChain(chain: StoredChain): void;
  setConsumed(chainId: number, chainIndex: number): void;

  /** The engine as of the last crash, or `null` before the first. */
  readCheckpoint(): string | null;
  /** Every event since the checkpoint, in order. */
  readJournal(): JournalEntry[];
  append(entry: JournalEntry): void;
  /** Replaces the checkpoint and empties the journal it supersedes. */
  writeCheckpoint(snapshot: string): void;

  addReveal(reveal: RevealRecord): void;
  reveal(chainId: number, chainIndex: number): RevealRecord | null;

  playerForToken(token: string): string | null;
  addSession(token: string, playerId: string): void;

  /** Records an accepted `betId`; `false` if it was already taken. */
  claimBetId(betId: string, playerId: string): boolean;
  hasBetId(betId: string): boolean;

  /** A cheap round trip, for `/ready`. */
  ping(): void;
  close(): void;
}
