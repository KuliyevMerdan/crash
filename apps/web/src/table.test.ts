import type { GameView } from '@crash/client-core';
import { minor } from '@crash/money';
import type { PublicBet, RoundSnapshot } from '@crash/protocol';
import { describe, expect, it } from 'vitest';
import { gradeOf, tableModel, TABLE_ROWS } from './table.js';

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

const bet = (
  betId: string,
  nick: string,
  amount: number,
  cashedOutAt: number | null = null,
): PublicBet => ({
  betId,
  nick,
  amount: minor(amount),
  cashedOutAt,
});

function game(round: RoundSnapshot, mine: string[] = []): GameView {
  return {
    player: { id: 'p', nick: 'me', balance: minor(100_000) },
    config,
    chain: { id: 1, commit: 'c'.repeat(64), salt: 's', length: 10 },
    round,
    myBets: mine.map((betId) => ({
      roundId: round.roundId,
      betId,
      amount: minor(500),
      status: 'OPEN' as const,
      autoCashOutAt: 300,
    })),
    history: [],
    withdrawn: [],
  };
}

const running = (bets: PublicBet[]): RoundSnapshot => ({
  roundId: 'R',
  chainIndex: 4,
  phase: 'RUNNING',
  startedAt: 1,
  bets,
});

describe('tableModel — the live player list', () => {
  it('puts your bet first, then the largest stakes, and fills a cash-out in place', () => {
    const model = tableModel(
      game(
        running([
          bet('A', 'ada', 200),
          bet('B', 'bo', 5000, 150),
          bet('ME', 'me', 500),
          bet('C', 'cy', 5000),
        ]),
        ['ME'],
      ),
    );
    expect(model.rows.map((r) => r.betId)).toEqual(['ME', 'B', 'C', 'A']);
    expect(model.rows[0]).toMatchObject({
      mine: true,
      state: 'riding',
      multiplier: null,
      won: null,
    });
    expect(model.rows[1]).toMatchObject({ state: 'cashed', multiplier: 150, won: 7500 });
    expect(model).toMatchObject({ players: 4, staked: 10_700, cashedOut: 1, hidden: 0 });
  });

  it('never shows an auto cash-out target — a bet riding on auto looks like any other (D4)', () => {
    const model = tableModel(game(running([bet('ME', 'me', 500)]), ['ME']));
    // `myBets` holds the target (300); the row carries nothing that could reveal it.
    expect(Object.keys(model.rows[0] ?? {}).sort()).toEqual(
      ['amount', 'betId', 'mine', 'multiplier', 'nick', 'state', 'won'].sort(),
    );
    expect(JSON.stringify(model)).not.toContain('300');
  });

  it('marks the bets still in at the crash as lost', () => {
    const crashed: RoundSnapshot = {
      roundId: 'R',
      chainIndex: 4,
      phase: 'CRASHED',
      startedAt: 1,
      crashedAt: 2,
      crashPoint: 180,
      fair: null,
      bets: [bet('A', 'ada', 200, 150), bet('B', 'bo', 300)],
    };
    expect(tableModel(game(crashed)).rows.map((r) => r.state)).toEqual(['lost', 'cashed']);
  });

  it('draws at most TABLE_ROWS and counts the rest — always drawing yours', () => {
    const many = Array.from({ length: TABLE_ROWS + 20 }, (_, i) => bet(`B${i}`, `p${i}`, 1000 + i));
    const model = tableModel(game(running([...many, bet('ME', 'me', 100)]), ['ME']));
    expect(model.rows).toHaveLength(TABLE_ROWS);
    expect(model.rows[0]?.betId).toBe('ME');
    expect(model.hidden).toBe(21);
    expect(model.players).toBe(TABLE_ROWS + 21);
  });

  it('is empty while betting opens on an empty table', () => {
    const betting: RoundSnapshot = {
      roundId: 'R',
      chainIndex: 5,
      phase: 'BETTING',
      bettingClosesAt: 9,
      bets: [],
    };
    expect(tableModel(game(betting))).toMatchObject({ rows: [], players: 0, staked: 0 });
  });
});

describe('gradeOf — the history strip bands', () => {
  it.each([
    [100, 'low'],
    [199, 'low'],
    [200, 'mid'],
    [999, 'mid'],
    [1000, 'high'],
    [100_000_000, 'high'],
  ])('%d is %s', (point, grade) => expect(gradeOf(point)).toBe(grade));
});
