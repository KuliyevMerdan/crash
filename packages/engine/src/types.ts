import type { Curve } from '@crash/curve';
import type { Minor } from '@crash/money';
import type { GameConfig, HistoryEntry, ServerMessage } from '@crash/protocol';

/** The server's name for a connected wallet. Opaque to the engine. */
export type PlayerId = string;

export interface Player {
  readonly id: PlayerId;
  readonly nick: string;
  readonly balance: Minor;
}

// ── Bets ─────────────────────────────────────────────────────────────────────────────────────────

interface BetBase {
  readonly betId: string;
  readonly playerId: PlayerId;
  /** The nick at placement — what the table saw, even if the player renames mid-round. */
  readonly nick: string;
  readonly amount: Minor;
  readonly autoCashOutAt: number | null;
  /** The balance `betAccepted` carried, kept so a replayed `placeBet` replays it exactly (§7). */
  readonly acceptedBalance: Minor;
}

export type Bet =
  | (BetBase & { readonly status: 'OPEN' })
  | (BetBase & { readonly status: 'CANCELLED'; readonly cancelledBalance: Minor })
  | (BetBase & {
      readonly status: 'CASHED_OUT';
      readonly reason: 'MANUAL' | 'AUTO';
      readonly multiplier: number;
      readonly payout: Minor;
      /** The balance `cashOutResult` carried — replayed as-is by a retried `cashOut`. */
      readonly cashOutBalance: Minor;
      readonly cashedOutAt: number;
    })
  | (BetBase & { readonly status: 'LOST' });

// ── Rounds ───────────────────────────────────────────────────────────────────────────────────────

/** The chain link a round was drawn from — exactly what `crash.fair` reveals. */
export interface ChainLink {
  readonly chainId: number;
  readonly chainIndex: number;
  /**
   * **Secret until the crash.** Never copied into an effect or a snapshot before `CRASHED`
   * (CLAUDE.md § Other rules) — `engine.test.ts` asserts it over every effect of every phase.
   */
  readonly seed: string;
  readonly previousHash: string;
}

interface RoundBase {
  readonly roundId: string;
  /** `null` for a forced dev round — typed in, not drawn, so it claims no link (§9, D13). */
  readonly link: ChainLink | null;
  /** Decided at `openRound`, before any bet exists (ADR-0001). Secret until the crash, like the seed. */
  readonly crashPoint: number;
  readonly bettingClosesAt: number;
  /** Insertion-ordered: the order bets were placed is the order the table shows them. */
  readonly bets: ReadonlyMap<string, Bet>;
}

export interface AutoCashOut {
  readonly betId: string;
  readonly fireAt: number;
}

export type Round =
  | (RoundBase & { readonly phase: 'BETTING' })
  | (RoundBase & {
      readonly phase: 'RUNNING';
      readonly startedAt: number;
      /** `startedAt + t(crashPoint)` — computed once, at start (§4, D5). */
      readonly crashAt: number;
      /**
       * Every auto cash-out that will fire before the crash, in firing order. Fixed at start: no bet
       * is placed or cancelled while the round runs.
       */
      readonly autos: readonly AutoCashOut[];
    })
  | (RoundBase & {
      readonly phase: 'CRASHED';
      readonly startedAt: number;
      readonly crashedAt: number;
    });

export type CrashedRound = Extract<Round, { phase: 'CRASHED' }>;

// ── State, events, effects ───────────────────────────────────────────────────────────────────────

export interface EngineState {
  readonly config: GameConfig;
  readonly curve: Curve;
  readonly players: ReadonlyMap<PlayerId, Player>;
  /** `null` until the first `openRound`. */
  readonly round: Round | null;
  /**
   * The round before this one, kept so a retry that straddles the boundary — a `placeBet` accepted
   * just before betting closed, a `cashOut` answered just before the crash — replays its original
   * answer instead of being mistaken for something new (§7).
   */
  readonly previous: CrashedRound | null;
  /** Newest first, at most `HISTORY_LENGTH` — `hello.history`. */
  readonly history: readonly HistoryEntry[];
  /** Every amount ever granted to a player. Money enters the system here and nowhere else. */
  readonly granted: Minor;
  /** The house's net take: stakes lost minus winnings paid. Negative when players are ahead. */
  readonly house: Minor;
  /** The latest `now` the engine has been handed. Time does not run backwards (ADR-0002). */
  readonly now: number;
}

export type EngineEvent =
  | {
      readonly type: 'addPlayer';
      readonly playerId: PlayerId;
      readonly nick: string;
      readonly balance: Minor;
    }
  | { readonly type: 'renamePlayer'; readonly playerId: PlayerId; readonly nick: string }
  | {
      readonly type: 'openRound';
      readonly roundId: string;
      readonly source:
        | {
            readonly kind: 'chain';
            readonly chain: { readonly id: number; readonly salt: string };
            readonly chainIndex: number;
            readonly seed: string;
            readonly previousHash: string;
          }
        /** Development only — the server never builds one in production (§9). */
        | { readonly kind: 'forced'; readonly crashPoint: number };
    }
  | {
      readonly type: 'placeBet';
      readonly playerId: PlayerId;
      readonly betId: string;
      readonly roundId: string;
      readonly amount: Minor;
      readonly autoCashOutAt: number | null;
    }
  | { readonly type: 'cancelBet'; readonly playerId: PlayerId; readonly betId: string }
  | { readonly type: 'cashOut'; readonly playerId: PlayerId; readonly betId: string }
  /** Nothing new happened; bring the round up to `now` — the server's timer, at `nextDeadline`. */
  | { readonly type: 'advance' };

/**
 * What the caller must do with the new state. The engine never sends; it says what to send
 * (CLAUDE.md: "the engine never emits; it returns").
 */
export type Effect =
  | { readonly kind: 'broadcast'; readonly message: ServerMessage }
  | { readonly kind: 'send'; readonly playerId: PlayerId; readonly message: ServerMessage };

export interface Step {
  readonly state: EngineState;
  readonly effects: readonly Effect[];
}
