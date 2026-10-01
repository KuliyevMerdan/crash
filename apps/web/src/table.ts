import type { GameView } from '@crash/client-core';
import { ZERO, add, payout, type Minor } from '@crash/money';

/** How many rows the list draws; the rest are counted, not drawn. Your own bet is always drawn. */
export const TABLE_ROWS = 50;

export interface TableRow {
  readonly betId: string;
  readonly nick: string;
  readonly amount: Minor;
  /**
   * `riding` while the bet is in a round still running (or not yet started), `cashed` once its
   * owner got out, `lost` once the round crashed with it still in.
   */
  readonly state: 'riding' | 'cashed' | 'lost';
  /** The multiplier the owner got — `null` unless cashed. */
  readonly multiplier: number | null;
  /** What that paid. Public, since stakes and cash-out multipliers both are (§2.5) — not a balance. */
  readonly won: Minor | null;
  readonly mine: boolean;
}

export interface TableModel {
  readonly rows: readonly TableRow[];
  /** Bets on the table but not drawn (past `TABLE_ROWS`). */
  readonly hidden: number;
  readonly players: number;
  readonly staked: Minor;
  readonly cashedOut: number;
}

/**
 * The live player list, derived from the public table (§2.10). It shows what everyone can see — a
 * nick, a stake, the multiplier each one got — and **never anyone's auto cash-out target**, which
 * the wire does not carry (D4): a bet riding on auto looks exactly like one riding by hand.
 *
 * Order is by stake, largest first, with your own bet on top; a cash-out fills its row in place
 * rather than moving it, so the list does not jump under the reader's eye.
 */
export function tableModel(game: GameView): TableModel {
  const { round } = game;
  const mine = new Set(game.myBets.map((b) => b.betId));
  const crashed = round.phase === 'CRASHED';
  const all = round.bets.map((bet, at): TableRow & { at: number } => {
    const cashed = bet.cashedOutAt !== null;
    return {
      at,
      betId: bet.betId,
      nick: bet.nick,
      amount: bet.amount,
      state: cashed ? 'cashed' : crashed ? 'lost' : 'riding',
      multiplier: bet.cashedOutAt,
      won: bet.cashedOutAt === null ? null : payout(bet.amount, bet.cashedOutAt),
      mine: mine.has(bet.betId),
    };
  });
  all.sort(
    (a, b) => Number(b.mine) - Number(a.mine) || b.amount - a.amount || a.at - b.at, // stable
  );
  const rows = all.slice(0, TABLE_ROWS).map(({ at: _at, ...row }) => row);
  return {
    rows,
    hidden: all.length - rows.length,
    players: round.bets.length,
    staked: round.bets.reduce((sum, bet) => add(sum, bet.amount), ZERO),
    cashedOut: round.bets.filter((b) => b.cashedOutAt !== null).length,
  };
}

/**
 * The colour band of a past crash point, for the history strip: an early bust, an ordinary round,
 * a long one. Bands are by value, not by rarity — `P(crash ≥ m) = 0.99/m`, so about half the rounds
 * land below 2× and one in ten past 10×.
 */
export type Grade = 'low' | 'mid' | 'high';

export function gradeOf(crashPoint: number): Grade {
  if (crashPoint < 200) return 'low';
  if (crashPoint < 1000) return 'mid';
  return 'high';
}
