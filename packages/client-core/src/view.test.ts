import { minor } from '@crash/money';
import type { ServerMessage } from '@crash/protocol';
import { describe, expect, it } from 'vitest';
import { NEXT_ROUND, ROUND, betting, hello } from './__fixtures__/fake.js';
import { HISTORY_LENGTH, reduce, viewFromHello, type GameView } from './index.js';

const B1 = '01J8ZQ5A1B2C3D4E5F6G7H8J9K';
const B2 = '01J8ZQ5B9K8J7H6G5F4E3D2C1B';

function run(view: GameView, ...messages: object[]): { view: GameView; resyncs: number } {
  let resyncs = 0;
  for (const m of messages) {
    // The fixtures are wire-shaped JSON; the reducer takes what the parser hands it.
    const result = reduce(view, m as ServerMessage); // test data, not a boundary
    view = result.view;
    if (result.resync) resyncs += 1;
  }
  return { view, resyncs };
}

const start = () => viewFromHello(hello(betting(1)));
const running = (v: GameView) => run(v, { type: 'roundStart', roundId: ROUND, startedAt: 10 }).view;

describe('reduce', () => {
  it('builds the table from broadcasts and my bets from private replies', () => {
    const { view } = run(
      start(),
      { type: 'betPlaced', roundId: ROUND, betId: B1, nick: 'ada', amount: 500 },
      {
        type: 'betAccepted',
        roundId: ROUND,
        betId: B1,
        amount: 500,
        autoCashOutAt: null,
        balance: 99_500,
      },
      { type: 'betPlaced', roundId: ROUND, betId: B2, nick: 'bo', amount: 900 },
    );
    expect(view.round.bets.map((b) => b.betId)).toEqual([B1, B2]);
    expect(view.myBets).toEqual([
      { roundId: ROUND, betId: B1, amount: 500, status: 'OPEN', autoCashOutAt: null },
    ]);
    expect(view.player.balance).toBe(99_500);
  });

  it('ignores a replayed cash-out: the first result stands, and so does the balance after it', () => {
    let { view } = run(start(), {
      type: 'betAccepted',
      roundId: ROUND,
      betId: B1,
      amount: 500,
      autoCashOutAt: null,
      balance: 99_500,
    });
    view = running(view);
    const result = {
      type: 'cashOutResult',
      roundId: ROUND,
      betId: B1,
      reason: 'MANUAL',
      multiplier: 200,
      payout: 1000,
      balance: 100_500,
    };
    ({ view } = run(view, result, { ...result, balance: 42 }));
    expect(view.player.balance).toBe(100_500);
    expect(view.myBets[0]).toMatchObject({ status: 'CASHED_OUT', multiplier: 200, payout: 1000 });
  });

  it('ignores a betAccepted for a round already gone — a retry answered after the round moved on', () => {
    const { view, resyncs } = run(
      start(),
      { type: 'bettingOpen', roundId: NEXT_ROUND, chainIndex: 6, bettingClosesAt: 99 },
      {
        type: 'betAccepted',
        roundId: ROUND,
        betId: B1,
        amount: 500,
        autoCashOutAt: null,
        balance: 1,
      },
    );
    expect(resyncs).toBe(0);
    expect(view.myBets).toEqual([]);
    expect(view.player.balance).toBe(minor(100_000));
  });

  it('does not resurrect a withdrawn bet from a late broadcast or reply', () => {
    const { view } = run(
      start(),
      { type: 'betPlaced', roundId: ROUND, betId: B1, nick: 'ada', amount: 500 },
      { type: 'betWithdrawn', roundId: ROUND, betId: B1 },
      { type: 'betPlaced', roundId: ROUND, betId: B1, nick: 'ada', amount: 500 },
    );
    expect(view.round.bets).toEqual([]);
  });

  it('settles the crash: open bets lost, the reveal kept, the history capped', () => {
    const past = Array.from({ length: HISTORY_LENGTH }, (_, i) => ({
      roundId: `R${i}`,
      crashPoint: 100 + i,
    }));
    let view = viewFromHello(hello(betting(1), { history: past }));
    ({ view } = run(view, {
      type: 'betAccepted',
      roundId: ROUND,
      betId: B1,
      amount: 500,
      autoCashOutAt: 900,
      balance: 99_500,
    }));
    view = running(view);
    ({ view } = run(view, {
      type: 'crash',
      roundId: ROUND,
      crashPoint: 247,
      crashedAt: 99,
      fair: null,
      settled: [],
    }));
    expect(view.round).toMatchObject({
      phase: 'CRASHED',
      crashPoint: 247,
      startedAt: 10,
      crashedAt: 99,
      fair: null,
    });
    expect(view.myBets[0]?.status).toBe('LOST');
    expect(view.history).toHaveLength(HISTORY_LENGTH);
    expect(view.history[0]).toEqual({ roundId: ROUND, crashPoint: 247 });
  });

  it.each([
    [
      'a crash while still betting (a missed roundStart)',
      { type: 'crash', roundId: ROUND, crashPoint: 247, crashedAt: 9, fair: null, settled: [] },
    ],
    ['a tick while still betting', { type: 'tick', roundId: ROUND, elapsedMs: 1, multiplier: 100 }],
    [
      'a broadcast for an unknown round',
      { type: 'betPlaced', roundId: NEXT_ROUND, betId: B1, nick: 'x', amount: 100 },
    ],
  ])('asks for a resync on %s', (_label, message) => {
    expect(run(start(), message).resyncs).toBe(1);
  });
});
