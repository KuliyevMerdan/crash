import { curve, elapsedAt, multiplierAt } from '@crash/curve';
import { describe, expect, it } from 'vitest';
import { CONFIG, Table, amount, ulid } from './__fixtures__/table.js';
import {
  EngineError,
  createEngine,
  myBetsOf,
  nextDeadline,
  roundSnapshotOf,
  step,
  tickAt,
} from './index.js';

const K = curve(CONFIG.curve.growthRatePerSecond);
const B1 = ulid('B', 1);
const B2 = ulid('B', 2);
const B3 = ulid('B', 3);

/** A table with two players and a round open at t = 0, crashing at a point `want` accepts. */
function tableWith(want: (crashPoint: number) => boolean = (p) => p >= 500) {
  const table = new Table();
  table.addPlayer('alice');
  table.addPlayer('bob');
  const round = table.open(want, 0);
  return { table, ...round, startedAt: CONFIG.bettingPhaseMs };
}

describe('the phases, driven by time', () => {
  it('opens BETTING, starts RUNNING at the scheduled close, and crashes at t(crashPoint)', () => {
    const { table, roundId, crashPoint, startedAt } = tableWith();
    expect(table.messages()).toEqual([
      { type: 'bettingOpen', roundId, chainIndex: expect.any(Number), bettingClosesAt: startedAt },
    ]);
    expect(nextDeadline(table.state)).toEqual({ at: startedAt, due: 'advance' });

    table.advance(startedAt);
    expect(table.messages()).toEqual([{ type: 'roundStart', roundId, startedAt }]);

    const crashAt = startedAt + elapsedAt(K, crashPoint);
    expect(nextDeadline(table.state)).toEqual({ at: crashAt, due: 'advance' });
    table.advance(crashAt - 1);
    expect(table.state.round?.phase).toBe('RUNNING');
    table.advance(crashAt);
    expect(table.messages('crash')).toEqual([
      expect.objectContaining({ type: 'crash', roundId, crashPoint, crashedAt: crashAt }),
    ]);
    expect(nextDeadline(table.state)).toEqual({
      at: crashAt + CONFIG.crashedPhaseMs,
      due: 'openRound',
    });
  });

  it('uses the scheduled moments, not the moment the timer happened to fire', () => {
    const { table, crashPoint, startedAt } = tableWith();
    const crashAt = startedAt + elapsedAt(K, crashPoint);
    table.advance(crashAt + 5000); // one very late timer
    expect(table.log.map((e) => e.message.type)).toEqual(['bettingOpen', 'roundStart', 'crash']);
    expect(table.messages('roundStart')).toEqual([expect.objectContaining({ startedAt })]);
    expect(table.messages('crash')).toEqual([expect.objectContaining({ crashedAt: crashAt })]);
  });

  it('busts a 1.00× round at its start: RUNNING lasts zero milliseconds, no press beats it', () => {
    const { table, crashPoint, startedAt } = tableWith((p) => p === 100);
    expect(crashPoint).toBe(100);
    table.bet('alice', B1, 1000);
    table.cashOut('alice', B1, startedAt);
    expect(table.messages().map((m) => m.type)).toEqual(['roundStart', 'crash', 'error']);
    expect(table.sentTo('alice')).toEqual([expect.objectContaining({ code: 'TOO_LATE' })]);
    expect(table.balance('alice')).toBe(99_000);
  });

  it('refuses to open a round mid-round, or before the pause has run', () => {
    const { table } = tableWith();
    expect(() => table.open(undefined, 1)).toThrow(EngineError);
    table.runToCrash();
    const crashedAt = table.state.round?.phase === 'CRASHED' ? table.state.round.crashedAt : 0;
    expect(() => table.open(undefined, crashedAt + CONFIG.crashedPhaseMs - 1)).toThrow(/pause/);
    table.open(undefined, crashedAt + CONFIG.crashedPhaseMs);
    expect(table.state.round?.phase).toBe('BETTING');
  });

  it('refuses a seed that does not link to the hash it claims came before it', () => {
    const state = createEngine(CONFIG);
    expect(() =>
      step(
        state,
        {
          type: 'openRound',
          roundId: ulid('R', 1),
          source: {
            kind: 'chain',
            chain: { id: 1, salt: 'x' },
            chainIndex: 1,
            seed: 'ab'.repeat(32),
            previousHash: 'cd'.repeat(32),
          },
        },
        0,
      ),
    ).toThrow(/does not link/);
  });

  it('refuses time that runs backwards', () => {
    const { table } = tableWith();
    table.advance(100);
    expect(() => table.advance(99)).toThrow(/backwards/);
  });
});

describe('placing, cancelling and their refusals', () => {
  it('holds the stake, answers privately with the balance, and tells the table without it', () => {
    const { table, roundId } = tableWith();
    table.bet('alice', B1, 500, 200);
    expect(table.last).toEqual([
      {
        kind: 'send',
        playerId: 'alice',
        message: {
          type: 'betAccepted',
          roundId,
          betId: B1,
          amount: 500,
          autoCashOutAt: 200,
          balance: 99_500,
        },
      },
      {
        kind: 'broadcast',
        message: { type: 'betPlaced', roundId, betId: B1, nick: 'alice', amount: 500 },
      },
    ]);
  });

  it('never broadcasts autoCashOutAt (D4)', () => {
    const { table } = tableWith();
    table.bet('alice', B1, 500, 12_345);
    const broadcasts = table.last.filter((e) => e.kind === 'broadcast');
    expect(JSON.stringify(broadcasts)).not.toContain('12345');
  });

  it.each([
    ['below the minimum', 99, null, 'BET_OUT_OF_RANGE'],
    ['above the maximum', 50_001, null, 'BET_OUT_OF_RANGE'],
    ['an auto cash-out above the maximum', 500, 100_001, 'AUTO_CASHOUT_OUT_OF_RANGE'],
    ['more than the balance', 50_000, null, 'INSUFFICIENT_FUNDS'],
  ])('refuses a bet %s', (_label, stake, auto, code) => {
    const table = new Table();
    table.addPlayer('carol', 10_000);
    table.open(undefined, 0);
    table.bet('carol', B1, stake, auto);
    expect(table.sentTo('carol')).toEqual([
      expect.objectContaining({ type: 'error', class: 'PLAYER', code, betId: B1 }),
    ]);
    expect(table.balance('carol')).toBe(10_000);
  });

  it('allows one bet per player per round', () => {
    const { table } = tableWith();
    table.bet('alice', B1, 500);
    table.bet('alice', B2, 500);
    expect(table.sentTo('alice')).toEqual([expect.objectContaining({ code: 'ONE_BET_PER_ROUND' })]);
  });

  it('refuses a bet echoing a roundId that is not the open one, and one placed after the close', () => {
    const { table, startedAt } = tableWith();
    table.bet('alice', B1, 500, null, ulid('R', 99));
    expect(table.sentTo('alice')).toEqual([expect.objectContaining({ code: 'BETTING_CLOSED' })]);
    table.advance(startedAt);
    table.bet('bob', B2, 500);
    expect(table.sentTo('bob')).toEqual([expect.objectContaining({ code: 'BETTING_CLOSED' })]);
  });

  it('judges a bet at exactly the close as late — the close happens first', () => {
    const { table, startedAt } = tableWith();
    table.apply(
      {
        type: 'placeBet',
        playerId: 'alice',
        betId: B1,
        roundId: table.roundId(),
        amount: amount(500),
        autoCashOutAt: null,
      },
      startedAt,
    );
    expect(table.messages().map((m) => m.type)).toEqual(['roundStart', 'error']);
  });

  it('cancels during BETTING: stake back, private reply, public withdrawal', () => {
    const { table, roundId } = tableWith();
    table.bet('alice', B1, 500);
    table.cancel('alice', B1);
    expect(table.last).toEqual([
      {
        kind: 'send',
        playerId: 'alice',
        message: { type: 'betCancelled', roundId, betId: B1, balance: 100_000 },
      },
      { kind: 'broadcast', message: { type: 'betWithdrawn', roundId, betId: B1 } },
    ]);
    expect(roundSnapshotOf(table.state)?.bets).toEqual([]);
    expect(myBetsOf(table.state, 'alice')).toEqual([]);
  });

  it('lets a player bet again after cancelling — under a new betId', () => {
    const { table } = tableWith();
    table.bet('alice', B1, 500);
    table.cancel('alice', B1);
    table.bet('alice', B1, 500);
    expect(table.sentTo('alice')).toEqual([expect.objectContaining({ code: 'DUPLICATE_BET_ID' })]);
    table.bet('alice', B2, 700);
    expect(table.sentTo('alice')).toEqual([
      expect.objectContaining({ type: 'betAccepted', betId: B2 }),
    ]);
  });

  it('refuses a cancel once the round runs, and one for a bet that is not yours', () => {
    const { table, startedAt } = tableWith();
    table.bet('alice', B1, 500);
    table.cancel('bob', B1);
    expect(table.sentTo('bob')).toEqual([expect.objectContaining({ code: 'UNKNOWN_BET' })]);
    table.advance(startedAt);
    table.cancel('alice', B1);
    expect(table.sentTo('alice')).toEqual([expect.objectContaining({ code: 'BETTING_CLOSED' })]);
  });

  it('answers an unknown player with a SYSTEM error rather than guessing', () => {
    const { table } = tableWith();
    table.bet('mallory', B1, 500);
    expect(table.sentTo('mallory')).toEqual([
      expect.objectContaining({ class: 'SYSTEM', code: 'INTERNAL' }),
    ]);
  });
});

describe('cash-out resolves on receive time (ADR-0002)', () => {
  it('pays m(receivedAt − startedAt), floored, and tells the table the multiplier only', () => {
    const { table, roundId, startedAt } = tableWith((p) => p >= 500);
    table.bet('alice', B1, 500);
    const at = startedAt + elapsedAt(K, 421); // the first millisecond the curve reads 4.21×
    expect(multiplierAt(K, at - startedAt)).toBe(421);
    table.cashOut('alice', B1, at);
    expect(table.messages().filter((m) => m.type !== 'roundStart')).toEqual([
      {
        type: 'cashOutResult',
        roundId,
        betId: B1,
        reason: 'MANUAL',
        multiplier: 421,
        payout: 2105,
        balance: 101_605,
      },
      { type: 'playerCashedOut', roundId, betId: B1, nick: 'alice', multiplier: 421 },
    ]);
  });

  it('a millisecond before the crash wins; at the crash moment it loses', () => {
    const { table, crashPoint, startedAt } = tableWith((p) => p >= 300 && p <= 2000);
    const crashAt = startedAt + elapsedAt(K, crashPoint);
    table.bet('alice', B1, 1000);
    table.bet('bob', B2, 1000);

    table.cashOut('alice', B1, crashAt - 1);
    const won = table.sentTo('alice')[0];
    expect(won).toMatchObject({
      type: 'cashOutResult',
      multiplier: multiplierAt(K, crashAt - 1 - startedAt),
    });
    expect(won?.type === 'cashOutResult' && won.multiplier).toBeLessThan(crashPoint);

    table.cashOut('bob', B2, crashAt);
    expect(table.messages().map((m) => m.type)).toEqual(['crash', 'error']);
    expect(table.sentTo('bob')).toEqual([expect.objectContaining({ code: 'TOO_LATE' })]);
    expect(table.balance('bob')).toBe(99_000);
  });

  it('refuses a cash-out before the round starts', () => {
    const { table } = tableWith();
    table.bet('alice', B1, 500);
    table.cashOut('alice', B1);
    expect(table.sentTo('alice')).toEqual([expect.objectContaining({ code: 'NOT_RUNNING' })]);
  });

  it('pays two racing presses on one betId exactly once — the second replays the first', () => {
    const { table, startedAt } = tableWith();
    table.bet('alice', B1, 500);
    table.cashOut('alice', B1, startedAt + 5000);
    const first = table.sentTo('alice');
    table.cashOut('alice', B1, startedAt + 5001);
    expect(table.sentTo('alice')).toEqual(first);
    expect(table.last.filter((e) => e.kind === 'broadcast')).toEqual([]);
    expect(table.balance('alice')).toBe(
      first[0]?.type === 'cashOutResult' ? first[0].balance : NaN,
    );
  });

  it('replays a win even after the crash, rather than calling it late', () => {
    const { table, startedAt } = tableWith();
    table.bet('alice', B1, 500);
    table.cashOut('alice', B1, startedAt + 100);
    const result = table.sentTo('alice');
    table.runToCrash();
    table.cashOut('alice', B1);
    expect(table.sentTo('alice')).toEqual(result);
  });

  it('refuses a cash-out of someone else’s bet, a cancelled bet, and a bet that never was', () => {
    const { table, startedAt } = tableWith();
    table.bet('alice', B1, 500);
    table.bet('bob', B2, 500);
    table.cancel('bob', B2);
    table.advance(startedAt + 1000);
    for (const [who, id] of [
      ['bob', B1],
      ['bob', B2],
      ['alice', B3],
    ] as const) {
      table.cashOut(who, id);
      expect(table.sentTo(who)).toEqual([expect.objectContaining({ code: 'UNKNOWN_BET' })]);
    }
  });
});

describe('auto cash-out fires server-side at exactly t(autoCashOutAt)', () => {
  it('fires at the scheduled millisecond and pays exactly the target, however late it is processed', () => {
    const { table, startedAt } = tableWith((p) => p >= 1000);
    table.bet('alice', B1, 500, 250);
    const fireAt = startedAt + elapsedAt(K, 250);
    table.advance(startedAt);
    expect(nextDeadline(table.state)).toEqual({ at: fireAt, due: 'advance' });
    table.advance(fireAt + 777); // the timer was late
    expect(table.sentTo('alice')).toEqual([
      expect.objectContaining({
        type: 'cashOutResult',
        reason: 'AUTO',
        multiplier: 250,
        payout: 1250,
      }),
    ]);
  });

  it('pays the target, not the higher value the curve jumped to in the same millisecond', () => {
    // Past 100×, one millisecond moves the curve several hundredths.
    let target = 15_000;
    while (multiplierAt(K, elapsedAt(K, target)) === target) target += 1;
    const { table, startedAt } = tableWith((p) => p > target + 100);
    table.bet('alice', B1, 100, target);
    table.advance(startedAt + elapsedAt(K, target));
    expect(multiplierAt(K, elapsedAt(K, target))).toBeGreaterThan(target);
    expect(table.sentTo('alice')).toEqual([
      expect.objectContaining({ multiplier: target, payout: target }),
    ]);
  });

  it('wins at exactly the crash point, and not a hundredth above it (§4, D14)', () => {
    // P(crash ≥ x) = (1 − E) / x is what gives every target the same expected return (§3.2), so
    // an auto cash-out at the crash point itself must win — the curve did reach it.
    const { table, crashPoint } = tableWith((p) => p >= 200 && p < 90_000);
    table.bet('alice', B1, 500, crashPoint);
    table.bet('bob', B2, 500, crashPoint + 1);
    table.runToCrash();
    const results = (who: string) =>
      table.log.filter(
        (e) => e.kind === 'send' && e.playerId === who && e.message.type === 'cashOutResult',
      );
    expect(results('alice')).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ reason: 'AUTO', multiplier: crashPoint }),
      }),
    ]);
    expect(results('bob')).toEqual([]);
  });

  it('wins below the crash point even when the curve passes both in the same millisecond', () => {
    // Past ~66×, one millisecond moves the curve more than a hundredth: find a target below the
    // crash point that is first reached at the crash moment itself.
    const { table, crashPoint, startedAt } = tableWith((p) => p >= 20_000 && p < 90_000);
    let target = crashPoint - 1;
    while (target > 101 && elapsedAt(K, target) === elapsedAt(K, crashPoint)) target -= 1;
    target += 1; // the lowest target sharing the crash millisecond
    expect(target).toBeLessThan(crashPoint);
    table.bet('alice', B1, 100, target);
    table.advance(startedAt + elapsedAt(K, crashPoint));
    expect(table.messages().map((m) => m.type)).toEqual([
      'roundStart',
      'cashOutResult',
      'playerCashedOut',
      'crash',
    ]);
    expect(table.sentTo('alice')).toEqual([
      expect.objectContaining({ reason: 'AUTO', multiplier: target }),
    ]);
  });

  it('beats a manual press in the same millisecond, and the press replays it with reason AUTO', () => {
    const { table, startedAt } = tableWith((p) => p >= 500);
    table.bet('alice', B1, 500, 300);
    const fireAt = startedAt + elapsedAt(K, 300);
    table.cashOut('alice', B1, fireAt);
    const results = table.sentTo('alice').filter((m) => m.type === 'cashOutResult');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ reason: 'AUTO', multiplier: 300 });
    expect(table.balance('alice')).toBe(100_000 - 500 + 1500);
  });

  it('loses to a manual press one millisecond earlier, and then does not fire', () => {
    const { table, startedAt } = tableWith((p) => p >= 500);
    table.bet('alice', B1, 500, 300);
    const fireAt = startedAt + elapsedAt(K, 300);
    table.cashOut('alice', B1, fireAt - 1);
    expect(table.sentTo('alice')).toEqual([
      expect.objectContaining({ reason: 'MANUAL', multiplier: 299 }),
    ]);
    table.runToCrash();
    const results = table.log.filter(
      (e) => e.kind === 'send' && e.message.type === 'cashOutResult',
    );
    expect(results).toHaveLength(1);
  });

  it('fires several autos in firing order, placement order breaking ties', () => {
    const { table, startedAt } = tableWith((p) => p >= 1000);
    table.addPlayer('carol');
    table.bet('alice', B1, 100, 400);
    table.bet('bob', B2, 100, 200);
    table.bet('carol', B3, 100, 200);
    table.advance(startedAt + elapsedAt(K, 400));
    const order = table
      .messages('playerCashedOut')
      .map((m) => (m.type === 'playerCashedOut' ? m.nick : ''));
    expect(order).toEqual(['bob', 'carol', 'alice']);
  });
});

describe('settlement at the crash', () => {
  it('resolves every bet exactly once, reveals the seed, and moves no money for a loss', () => {
    const { table, startedAt } = tableWith((p) => p >= 300);
    table.bet('alice', B1, 500);
    table.bet('bob', B2, 800);
    table.cashOut('alice', B1, startedAt + 3000);
    table.runToCrash();
    const crashMessage = table.messages('crash')[0];
    expect(crashMessage).toMatchObject({
      settled: [
        { betId: B1, nick: 'alice', won: true },
        { betId: B2, nick: 'bob', won: false },
      ],
      fair: { chainId: 1, seed: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(table.balance('bob')).toBe(99_200);
    expect(myBetsOf(table.state, 'bob')).toEqual([expect.objectContaining({ status: 'LOST' })]);
  });

  it('keeps the last 30 crash points, newest first', () => {
    const table = new Table();
    const points: number[] = [];
    for (let i = 0; i < 33; i += 1) {
      points.unshift(table.open().crashPoint);
      table.runToCrash();
    }
    expect(table.state.history.map((h) => h.crashPoint)).toEqual(points.slice(0, 30));
  });

  it('records where each round sits in the chain — and no link for a forced one (D16)', () => {
    const table = new Table();
    table.open();
    table.runToCrash();
    table.openForced(250);
    table.runToCrash();
    const [forced, drawn] = table.state.history;
    expect(forced?.link).toBeNull();
    expect(drawn?.link).toEqual({ chainId: 1, chainIndex: 1 });
    // Only the coordinates: the seed is in `crash.fair` and `GET /fair/…`, not repeated per entry.
    expect(Object.keys(drawn?.link ?? {})).toEqual(['chainId', 'chainIndex']);
  });
});

describe('a retry that straddles the round boundary gets its original answer (§7)', () => {
  it('replays an accepted bet for the round it named, after that round has moved on', () => {
    const { table, roundId, startedAt } = tableWith();
    table.bet('alice', B1, 500);
    const accepted = table.sentTo('alice');
    table.advance(startedAt);
    table.bet('alice', B1, 500, null, roundId); // the retry arrives late
    expect(table.sentTo('alice')).toEqual(accepted);
    table.runToCrash();
    table.open();
    table.bet('alice', B1, 500, null, roundId); // and later still, from the previous round
    expect(table.sentTo('alice')).toEqual(accepted);
  });

  it('calls a betId from the previous round, placed into this one, a duplicate', () => {
    const { table } = tableWith();
    table.bet('alice', B1, 500);
    table.runToCrash();
    table.open();
    table.bet('alice', B1, 500);
    expect(table.sentTo('alice')).toEqual([expect.objectContaining({ code: 'DUPLICATE_BET_ID' })]);
  });

  it('replays a cash-out and refuses a lost bet as late, across the boundary', () => {
    const { table, startedAt } = tableWith((p) => p >= 300);
    table.bet('alice', B1, 500);
    table.bet('bob', B2, 500);
    table.cashOut('alice', B1, startedAt + 2000);
    const result = table.sentTo('alice');
    table.runToCrash();
    table.open();
    table.cashOut('alice', B1);
    expect(table.sentTo('alice')).toEqual(result);
    table.cashOut('bob', B2);
    expect(table.sentTo('bob')).toEqual([expect.objectContaining({ code: 'TOO_LATE' })]);
  });

  it('replays a cancel', () => {
    const { table } = tableWith();
    table.bet('alice', B1, 500);
    table.cancel('alice', B1);
    const reply = table.sentTo('alice');
    table.cancel('alice', B1);
    expect(table.sentTo('alice')).toEqual(reply);
  });
});

describe('nothing secret leaves before the crash (ADR-0001)', () => {
  it('keeps the seed and the crash point out of every effect, snapshot and tick until the crash', () => {
    const { table, crashPoint, startedAt } = tableWith((p) => p >= 3000);
    const seed = table.state.round?.link?.seed ?? '';
    table.bet('alice', B1, 500, 20_000);
    const crashAt = startedAt + elapsedAt(K, crashPoint);
    const before: unknown[] = [];
    for (let t = 0; t < crashAt; t += 250) {
      before.push(
        ...table.advance(t),
        roundSnapshotOf(table.state),
        myBetsOf(table.state, 'alice'),
        tickAt(table.state, t),
      );
    }
    const text = JSON.stringify(before);
    expect(text).not.toContain(seed);
    expect(text).not.toMatch(new RegExp(`"crashPoint":${crashPoint}\\b`));

    table.advance(crashAt);
    expect(JSON.stringify(table.last)).toContain(seed);
    expect(roundSnapshotOf(table.state)).toMatchObject({
      phase: 'CRASHED',
      crashPoint,
      fair: { seed },
    });
  });
});

describe('snapshots and ticks', () => {
  it('restores a reconnecting player: the round in its phase, and their own bet with its strategy', () => {
    const { table, roundId, startedAt } = tableWith();
    table.bet('alice', B1, 500, 777);
    table.bet('bob', B2, 900);
    table.advance(startedAt + 1000);
    expect(roundSnapshotOf(table.state)).toEqual({
      roundId,
      phase: 'RUNNING',
      chainIndex: expect.any(Number),
      startedAt,
      bets: [
        { betId: B1, nick: 'alice', amount: 500, cashedOutAt: null },
        { betId: B2, nick: 'bob', amount: 900, cashedOutAt: null },
      ],
    });
    expect(myBetsOf(table.state, 'alice')).toEqual([
      { roundId, betId: B1, amount: 500, status: 'OPEN', autoCashOutAt: 777 },
    ]);
  });

  it('ticks from the curve during RUNNING only, never at or past the crash moment', () => {
    const { table, crashPoint, startedAt } = tableWith((p) => p >= 300);
    const crashAt = startedAt + elapsedAt(K, crashPoint);
    expect(tickAt(table.state, startedAt)).toBeNull(); // still BETTING until advanced
    table.advance(startedAt + 3400);
    expect(tickAt(table.state, startedAt + 3400)).toEqual({
      type: 'tick',
      roundId: table.roundId(),
      elapsedMs: 3400,
      multiplier: 166,
    });
    expect(tickAt(table.state, crashAt)).toBeNull();
  });

  it('keeps the nick a bet was placed under when the player renames mid-round', () => {
    const { table } = tableWith();
    table.bet('alice', B1, 500);
    table.apply({ type: 'renamePlayer', playerId: 'alice', nick: 'alice2' });
    expect(roundSnapshotOf(table.state)?.bets[0]?.nick).toBe('alice');
    expect(table.state.players.get('alice')?.nick).toBe('alice2');
  });
});

describe('a forced dev round (§9, D13)', () => {
  it('crashes at exactly the typed-in point, and claims no chain link anywhere on the wire', () => {
    const table = new Table();
    table.addPlayer('alice');
    const roundId = table.openForced(250, 0);
    expect(table.messages()).toEqual([
      { type: 'bettingOpen', roundId, chainIndex: null, bettingClosesAt: 7000 },
    ]);
    table.bet('alice', B1, 1000, 200);
    table.runToCrash();
    expect(table.messages('crash')).toEqual([
      expect.objectContaining({ crashPoint: 250, crashedAt: 7000 + elapsedAt(K, 250), fair: null }),
    ]);
    expect(roundSnapshotOf(table.state)).toMatchObject({
      chainIndex: null,
      fair: null,
      crashPoint: 250,
    });
    expect(table.balance('alice')).toBe(100_000 - 1000 + 2000);
  });

  it('refuses a crash point outside the range', () => {
    const table = new Table();
    expect(() => table.openForced(99, 0)).toThrow(EngineError);
  });
});
