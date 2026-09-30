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

export function panelModel(state: ClientState, form: Form, pending: Pending): PanelModel {
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
    if (mine?.status === 'OPEN') {
      return {
        mode: 'cancel',
        betId: mine.betId,
        enabled: pending === null,
        label: pending === 'cancelling' ? 'Cancelling…' : 'Cancel bet',
        note: `Your bet: ${formatMinor(mine.amount)}${mine.autoCashOutAt === null ? '' : ` · auto at ${x(mine.autoCashOutAt)}`}. You can cancel until the round starts.`,
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
