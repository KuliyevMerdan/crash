import type { ClientState } from '@crash/client-core';
import { formatMinor, type Minor } from '@crash/money';
import { parseMultiplier, parseStake } from './stake.js';

/** What the player has typed, as the form holds it. */
export interface Form {
  readonly stakeText: string;
  readonly autoOn: boolean;
  readonly autoText: string;
}

/** A request in flight — the panel says so rather than letting a second press start. */
export type Pending = 'placing' | 'cancelling' | 'cashing' | null;

/**
 * What the panel shows and allows, derived — never stored — from the client's state and the form.
 * Pure, so every disabled state and its reason is a test, not a hunch. **A disabled control always
 * says why** (ROADMAP C2).
 */
export type PanelModel =
  | { readonly mode: 'offline'; readonly note: string }
  | {
      readonly mode: 'bet';
      readonly enabled: boolean;
      readonly stake: Minor | null;
      readonly auto: number | null;
      readonly label: string;
      readonly note: string | null;
    }
  | {
      readonly mode: 'cancel';
      readonly betId: string;
      readonly enabled: boolean;
      readonly label: string;
      readonly note: string;
    }
  | {
      readonly mode: 'cashout';
      readonly betId: string;
      readonly stake: Minor;
      readonly auto: number | null;
      readonly enabled: boolean;
    }
  | { readonly mode: 'settled'; readonly note: string }
  | { readonly mode: 'watching'; readonly note: string };

const x = (hundredths: number) => `${(hundredths / 100).toFixed(2)}×`;

/**
 * Beyond half a round trip, how much earlier than the close a bet or a cancel must leave to arrive
 * in time: the slack for a resend on a lossy link (P0 measured the uplink's p99).
 */
export const LAST_CALL_MARGIN_MS = 150;

/**
 * The last moment, on the server's clock, a press sent from here still reaches the server before
 * betting closes — the betting window's counterpart of the cash-out's landing price (ADR-0002).
 */
export function lastCallAt(state: ClientState): number | null {
  const round = state.game?.round;
  if (round?.phase !== 'BETTING') return null;
  return round.bettingClosesAt - (state.clock.rtt ?? 0) / 2 - LAST_CALL_MARGIN_MS;
}

/** `serverNow` is the client's estimate of the server's clock, for the last call. */
export function panelModel(
  state: ClientState,
  form: Form,
  pending: Pending,
  serverNow: number,
): PanelModel {
  const game = state.game;
  if (game === null || state.status !== 'live') {
    return {
      mode: 'offline',
      note:
        game === null
          ? 'Connecting to the table…'
          : 'Reconnecting — a bet you placed is safe on the server, and an auto cash-out still fires.',
    };
  }
  const { round, config, player } = game;
  const mine = game.myBets[0];

  if (round.phase === 'BETTING') {
    const late = serverNow >= (lastCallAt(state) ?? Number.POSITIVE_INFINITY);
    const ping = `ping ${Math.round(state.clock.rtt ?? 0)} ms`;
    if (mine?.status === 'OPEN') {
      return {
        mode: 'cancel',
        betId: mine.betId,
        enabled: pending === null && !late,
        label: pending === 'cancelling' ? 'Cancelling…' : 'Cancel bet',
        note: late
          ? `Your bet: ${formatMinor(mine.amount)}. Too late to cancel — betting closes before a cancel could reach the server (${ping}).`
          : `Your bet: ${formatMinor(mine.amount)}${mine.autoCashOutAt === null ? '' : ` · auto at ${x(mine.autoCashOutAt)}`}. You can cancel until the round starts.`,
      };
    }
    const stake = parseStake(form.stakeText);
    const auto = form.autoOn ? parseMultiplier(form.autoText) : null;
    const problem = ((): string | null => {
      if (stake === null) return 'Enter an amount like 5.00.';
      if (stake < config.minBet) return `The minimum bet is ${formatMinor(config.minBet)}.`;
      if (stake > config.maxBet) return `The maximum bet is ${formatMinor(config.maxBet)}.`;
      if (stake > player.balance)
        return `Not enough balance — you have ${formatMinor(player.balance)}.`;
      if (form.autoOn && (auto === null || auto < 101 || auto > config.maxAutoCashOut)) {
        return `Auto cash-out goes from 1.01× to ${x(config.maxAutoCashOut)}.`;
      }
      if (late) {
        return `Too late for this round — a bet sent now would reach the server after betting closes (${ping}).`;
      }
      return null;
    })();
    return {
      mode: 'bet',
      enabled: problem === null && pending === null,
      stake,
      auto: form.autoOn ? auto : null,
      label:
        pending === 'placing'
          ? 'Placing…'
          : stake === null
            ? 'Place bet'
            : `Place bet · ${formatMinor(stake)}`,
      note: problem,
    };
  }

  if (round.phase === 'RUNNING') {
    if (mine?.status === 'OPEN') {
      return {
        mode: 'cashout',
        betId: mine.betId,
        stake: mine.amount,
        auto: mine.autoCashOutAt,
        enabled: pending === null,
      };
    }
    if (mine?.status === 'CASHED_OUT') {
      return {
        mode: 'settled',
        note: `Cashed out at ${x(mine.multiplier)} · +${formatMinor(mine.payout)}. Watching the rest of the round.`,
      };
    }
    return {
      mode: 'watching',
      note: 'The round is running — bets open again as soon as it crashes.',
    };
  }

  // CRASHED
  return { mode: 'watching', note: 'The next round opens in a moment.' };
}
