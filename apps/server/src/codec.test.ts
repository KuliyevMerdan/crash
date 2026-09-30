import { createEngine, step, type EngineState } from '@crash/engine';
import { createChain } from '@crash/fair';
import { minor } from '@crash/money';
import { describe, expect, it } from 'vitest';
import { decodeEvent, decodeState, encodeEvent, encodeState } from './codec.js';
import { DEFAULT_GAME } from './config.js';

const chain = createChain('77'.repeat(32), 50);

function played(): EngineState {
  let s = createEngine(DEFAULT_GAME);
  const go = (e: Parameters<typeof step>[1], now: number) => (s = step(s, e, now).state);
  go({ type: 'addPlayer', playerId: 'p1', nick: 'ada', balance: minor(10_000) }, 0);
  go({ type: 'addPlayer', playerId: 'p2', nick: 'bo', balance: minor(10_000) }, 0);
  const open = (roundId: string, j: number, now: number) =>
    go(
      {
        type: 'openRound',
        roundId,
        source: {
          kind: 'chain',
          chain: { id: 1, salt: 's' },
          chainIndex: j,
          seed: chain.seedAt(j),
          previousHash: j === 1 ? chain.commit : chain.seedAt(j - 1),
        },
      },
      now,
    );
  open('R1', 1, 0);
  go(
    {
      type: 'placeBet',
      playerId: 'p1',
      betId: 'B1',
      roundId: 'R1',
      amount: minor(500),
      autoCashOutAt: 150,
    },
    10,
  );
  go({ type: 'advance' }, 60_000);
  open('R2', 2, 70_000);
  go(
    {
      type: 'placeBet',
      playerId: 'p2',
      betId: 'B2',
      roundId: 'R2',
      amount: minor(700),
      autoCashOutAt: null,
    },
    70_010,
  );
  go(
    {
      type: 'placeBet',
      playerId: 'p1',
      betId: 'B3',
      roundId: 'R2',
      amount: minor(300),
      autoCashOutAt: 5000,
    },
    70_020,
  );
  go({ type: 'advance' }, 77_000); // running
  return s;
}

describe('the checkpoint codec', () => {
  it('round-trips a running round, its bets, the previous round and the history exactly', () => {
    const state = played();
    expect(state.round?.phase).toBe('RUNNING');
    const back = decodeState(encodeState(state), DEFAULT_GAME);
    expect(back).toEqual(state);
  });

  it('refuses a checkpoint that does not parse, rather than play on from it', () => {
    const json = JSON.parse(encodeState(played()));
    json.players[0].balance = 12.5;
    expect(() => decodeState(JSON.stringify(json), DEFAULT_GAME)).toThrow();
  });

  it('round-trips every kind of event', () => {
    const events = [
      { type: 'addPlayer', playerId: 'p', nick: 'n', balance: minor(1) },
      { type: 'renamePlayer', playerId: 'p', nick: 'm' },
      { type: 'openRound', roundId: 'R', source: { kind: 'forced', crashPoint: 250 } },
      {
        type: 'placeBet',
        playerId: 'p',
        betId: 'B',
        roundId: 'R',
        amount: minor(100),
        autoCashOutAt: null,
      },
      { type: 'cancelBet', playerId: 'p', betId: 'B' },
      { type: 'cashOut', playerId: 'p', betId: 'B' },
      { type: 'advance' },
    ] as const;
    for (const event of events) expect(decodeEvent(encodeEvent(event))).toEqual(event);
  });
});
