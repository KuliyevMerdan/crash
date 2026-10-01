import type { ClientState, GameView } from '@crash/client-core';
import { minor } from '@crash/money';
import { describe, expect, it } from 'vitest';
import { LAST_CALL_MARGIN_MS, lastCallAt, panelModel, type Form } from './panel.js';
import { parseMultiplier, parseStake, stakeText } from './stake.js';

const config = {
  curve: { growthRatePerSecond: 0.15 },
  bettingPhaseMs: 7000,
  crashedPhaseMs: 3000,
  tickIntervalMs: 100,
  minBet: minor(100),
  maxBet: minor(50_000),
  maxAutoCashOut: 100_000,
  houseEdgeBps: 100,
};
const BETTING: GameView['round'] = {
  roundId: 'R',
  chainIndex: 1,
  phase: 'BETTING',
  bettingClosesAt: 10_000,
  bets: [],
};
const RUNNING: GameView['round'] = {
  roundId: 'R',
  chainIndex: 1,
  phase: 'RUNNING',
  startedAt: 1,
  bets: [],
};

function state(
  round: GameView['round'],
  myBets: GameView['myBets'] = [],
  balance = 10_000,
  status: ClientState['status'] = 'live',
): ClientState {
  return {
    status,
    clock: { offset: 0, rtt: 300 },
    game: {
      player: { id: 'p', nick: 'ada', balance: minor(balance) },
      config,
      chain: { id: 1, commit: 'c'.repeat(64), salt: 's', length: 10 },
      round,
      myBets,
      history: [],
      withdrawn: [],
    },
  };
}
const form = (stakeText = '5.00', autoOn = false, autoText = '2.00'): Form => ({
  stakeText,
  autoOn,
  autoText,
});

describe('parsing what the player types', () => {
  it.each([
    ['5', 500],
    ['5.5', 550],
    ['5.50', 550],
    ['0.29', 29],
    [' 12,75 ', 1275],
  ])('%j is %d minor units — digit by digit, never a float', (text, minorUnits) => {
    expect(parseStake(text)).toBe(minorUnits);
  });

  it.each(['', 'abc', '5.555', '-5', '1e3', '5.'])('refuses %j rather than guess', (text) => {
    expect(parseStake(text)).toBeNull();
  });

  it('writes an amount back the way the input shows it', () => {
    expect(stakeText(minor(505))).toBe('5.05');
    expect(stakeText(minor(100_000))).toBe('1000.00');
  });

  it.each([
    ['2', 200],
    ['1.01', 101],
    ['2.5×', 250],
  ])('reads the auto cash-out %j as %d hundredths', (text, h) => {
    expect(parseMultiplier(text)).toBe(h);
  });
});

describe('the panel says what it will do, and why it will not', () => {
  it('offers a bet during betting, priced in the button', () => {
    expect(panelModel(state(BETTING), form('5.00'), null, 0)).toEqual({
      mode: 'bet',
      enabled: true,
      stake: 500,
      auto: null,
      label: 'Place bet · 5.00',
      note: null,
    });
  });

  it.each([
    ['nonsense', form('five'), 'Enter an amount like 5.00.'],
    ['below the minimum', form('0.50'), 'The minimum bet is 1.00.'],
    ['above the maximum', form('600'), 'The maximum bet is 500.00.'],
    ['more than the balance', form('200'), 'Not enough balance — you have 100.00.'],
    [
      'an auto cash-out at 1.00×',
      form('5', true, '1'),
      'Auto cash-out goes from 1.01× to 1000.00×.',
    ],
    [
      'an auto cash-out past the limit',
      form('5', true, '2000'),
      'Auto cash-out goes from 1.01× to 1000.00×.',
    ],
  ])('disables the bet for %s, and says so', (_label, f, note) => {
    expect(panelModel(state(BETTING), f, null, 0)).toMatchObject({
      mode: 'bet',
      enabled: false,
      note,
    });
  });

  it('will not start a second bet while the first is on its way', () => {
    expect(panelModel(state(BETTING), form(), 'placing', 0)).toMatchObject({
      enabled: false,
      label: 'Placing…',
    });
  });

  it('turns into a cancel once the bet is on the table, until the round starts', () => {
    const bet = {
      roundId: 'R',
      betId: 'B',
      amount: minor(500),
      status: 'OPEN' as const,
      autoCashOutAt: 250,
    };
    expect(panelModel(state(BETTING, [bet]), form(), null, 0)).toEqual({
      mode: 'cancel',
      betId: 'B',
      enabled: true,
      label: 'Cancel bet',
      note: 'Your bet: 5.00 · auto at 2.50×. You can cancel until the round starts.',
    });
  });

  it('stops offering a bet or a cancel that would reach the server after betting closes', () => {
    // rtt 300: a press leaves 150 ms before it lands, plus the margin for a resend.
    const last = lastCallAt(state(BETTING));
    expect(last).toBe(10_000 - 150 - LAST_CALL_MARGIN_MS);
    expect(panelModel(state(BETTING), form(), null, (last ?? 0) - 1)).toMatchObject({
      enabled: true,
    });
    expect(panelModel(state(BETTING), form(), null, last ?? 0)).toMatchObject({
      mode: 'bet',
      enabled: false,
      note: 'Too late for this round — a bet sent now would reach the server after betting closes (ping 300 ms).',
    });
    const bet = {
      roundId: 'R',
      betId: 'B',
      amount: minor(500),
      status: 'OPEN' as const,
      autoCashOutAt: null,
    };
    expect(panelModel(state(BETTING, [bet]), form(), null, last ?? 0)).toMatchObject({
      mode: 'cancel',
      enabled: false,
      note: 'Your bet: 5.00. Too late to cancel — betting closes before a cancel could reach the server (ping 300 ms).',
    });
    expect(lastCallAt(state(RUNNING))).toBeNull();
  });

  it('becomes the cash-out while the round runs with an open bet', () => {
    const bet = {
      roundId: 'R',
      betId: 'B',
      amount: minor(500),
      status: 'OPEN' as const,
      autoCashOutAt: null,
    };
    expect(panelModel(state(RUNNING, [bet]), form(), null, 0)).toEqual({
      mode: 'cashout',
      betId: 'B',
      stake: 500,
      auto: null,
      enabled: true,
    });
    expect(panelModel(state(RUNNING, [bet]), form(), 'cashing', 0)).toMatchObject({
      enabled: false,
    });
  });

  it('shows the cash-out it made, and explains a round it is only watching', () => {
    const cashed = {
      roundId: 'R',
      betId: 'B',
      amount: minor(500),
      status: 'CASHED_OUT' as const,
      reason: 'MANUAL' as const,
      multiplier: 210,
      payout: minor(1050),
    };
    expect(panelModel(state(RUNNING, [cashed]), form(), null, 0)).toEqual({
      mode: 'settled',
      note: 'Cashed out at 2.10× · +10.50. Watching the rest of the round.',
    });
    expect(panelModel(state(RUNNING), form(), null, 0)).toMatchObject({ mode: 'watching' });
  });

  it('tells a reconnecting player their bet is safe, rather than greying everything out silently', () => {
    expect(panelModel(state(RUNNING, [], 10_000, 'reconnecting'), form(), null, 0)).toEqual({
      mode: 'offline',
      note: 'Reconnecting — a bet you placed is safe on the server, and an auto cash-out still fires.',
    });
  });
});
