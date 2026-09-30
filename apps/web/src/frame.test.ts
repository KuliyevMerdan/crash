import type { ClientState, GameView } from '@crash/client-core';
import { minor } from '@crash/money';
import { describe, expect, it } from 'vitest';
import { frameOf } from './frame.js';

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

function state(round: GameView['round'], status: ClientState['status'] = 'live'): ClientState {
  return {
    status,
    clock: { offset: 0, rtt: 20 },
    game: {
      player: { id: 'p', nick: 'ada', balance: minor(100_000) },
      config,
      chain: { id: 1, commit: 'c'.repeat(64), salt: 's', length: 10 },
      round,
      myBets: [],
      history: [{ roundId: 'R0', crashPoint: 318 }],
      withdrawn: [],
    },
  };
}

describe('frameOf', () => {
  it('counts down during betting, from the server’s clock', () => {
    const frame = frameOf(
      state({ roundId: 'R', chainIndex: 4, phase: 'BETTING', bettingClosesAt: 10_000, bets: [] }),
      6_580,
    );
    expect(frame).toEqual({ kind: 'waiting', closesInMs: 3_420, bettingMs: 7000, lastCrash: 318 });
  });

  it('draws a running round from serverNow − startedAt, and keeps drawing through a reconnect', () => {
    const round: GameView['round'] = {
      roundId: 'R',
      chainIndex: 4,
      phase: 'RUNNING',
      startedAt: 1_000,
      bets: [],
    };
    expect(frameOf(state(round), 5_621)).toEqual({ kind: 'running', elapsedMs: 4_621 });
    expect(frameOf(state(round, 'reconnecting'), 9_000)).toEqual({
      kind: 'running',
      elapsedMs: 8_000,
    });
  });

  it('freezes at the crash, counts to the next round, and says whether the round can be verified', () => {
    const crashed = {
      roundId: 'R',
      phase: 'CRASHED' as const,
      startedAt: 1_000,
      crashedAt: 7_040,
      crashPoint: 247,
      bets: [],
    };
    const fair = { chainId: 1, chainIndex: 4, seed: 'a'.repeat(64), previousHash: 'b'.repeat(64) };
    expect(frameOf(state({ ...crashed, chainIndex: 4, fair }), 7_540)).toEqual({
      kind: 'crashed',
      elapsedMs: 6_040,
      crashPoint: 247,
      sinceCrashMs: 500,
      nextInMs: 2_500,
      note: 'round #4 · seed revealed',
    });
    expect(frameOf(state({ ...crashed, chainIndex: null, fair: null }), 7_540)).toMatchObject({
      note: 'forced round (dev) · not verifiable',
    });
  });

  it('says what it is waiting for before the first hello', () => {
    expect(
      frameOf({ status: 'connecting', game: null, clock: { offset: null, rtt: null } }, 0),
    ).toEqual({ kind: 'idle', message: 'connecting…' });
    expect(
      frameOf({ status: 'reconnecting', game: null, clock: { offset: null, rtt: null } }, 0),
    ).toEqual({ kind: 'idle', message: 'reconnecting…' });
  });
});
