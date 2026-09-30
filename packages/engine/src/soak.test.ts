import { curve, elapsedAt, multiplierAt } from '@crash/curve';
import { crashPoint as crashPointOf, verifyLink } from '@crash/fair';
import type { ServerMessage } from '@crash/protocol';
import { describe, expect, it } from 'vitest';
import { CONFIG, SALT, Table, ulid } from './__fixtures__/table.js';
import { nextDeadline } from './index.js';

/**
 * ROADMAP S2 "Done when": a headless run of 10,000 seeded rounds with bets, auto cash-outs,
 * cancels, retries and late presses — no socket anywhere — in which the sum of all balances plus
 * the house take is exactly conserved.
 *
 * `Table` already audits the money and parses every effect against the wire schema after every
 * single step. This file adds the whole-run ledger: every bet resolved exactly once, every payout
 * the curve's number, every reveal verifiable.
 */

const K = curve(CONFIG.curve.growthRatePerSecond);
const ROUNDS = 10_000;
const PLAYERS = ['ada', 'bo', 'cy', 'di', 'ed', 'fay', 'gus', 'hal'];
const START = 1_000_000;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Ledger {
  playerId: string;
  amount: number;
  outcome: 'OPEN' | 'CANCELLED' | 'CASHED_OUT' | 'LOST';
  payout: number;
  resolutions: number;
}

describe(`${ROUNDS} seeded rounds through the engine alone`, () => {
  it('conserves money exactly, resolves every bet once, and pays only what the curve and the chain say', () => {
    const random = lcg(20260930);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const table = new Table();
    for (const id of PLAYERS) table.addPlayer(id, START);

    const bets = new Map<string, Ledger>();
    let betCounter = 0;
    let manualWins = 0;
    let lateLosses = 0;
    let replays = 0;
    const autos = new Set<string>();
    let previousRoundId: string | null = null;

    const record = (effects: readonly { message: ServerMessage }[]) => {
      for (const { message } of effects) {
        if (message.type === 'betPlaced') {
          expect(bets.has(message.betId)).toBe(false);
          // filled in by the placing code below, which knows the player
        } else if (message.type === 'betWithdrawn') {
          const bet = bets.get(message.betId);
          expect(bet?.outcome).toBe('OPEN');
          if (bet) {
            bet.outcome = 'CANCELLED';
            bet.resolutions += 1;
          }
        } else if (message.type === 'cashOutResult') {
          // Every payout, whichever step it arrived in — an auto cash-out fires inside whatever step
          // first reaches its moment, including another player's press. A replay repeats the same
          // number, so recording it twice changes nothing.
          const bet = bets.get(message.betId);
          if (bet) bet.payout = message.payout;
          if (message.reason === 'AUTO') autos.add(message.betId);
        } else if (message.type === 'playerCashedOut') {
          const bet = bets.get(message.betId);
          expect(bet?.outcome).toBe('OPEN');
          if (bet) {
            bet.outcome = 'CASHED_OUT';
            bet.resolutions += 1;
          }
        } else if (message.type === 'crash') {
          for (const s of message.settled) {
            const bet = bets.get(s.betId);
            expect(bet).toBeDefined();
            if (bet && !s.won) {
              expect(bet.outcome).toBe('OPEN');
              bet.outcome = 'LOST';
              bet.resolutions += 1;
            }
            if (bet && s.won) expect(bet.outcome).toBe('CASHED_OUT');
          }
        }
      }
    };

    for (let round = 0; round < ROUNDS; round += 1) {
      const { roundId, crashPoint } = table.open();
      record(table.last);
      const opened = table.state.round;
      if (opened?.phase !== 'BETTING') throw new Error('not betting');
      const startedAt = opened.bettingClosesAt;
      const crashAt = startedAt + elapsedAt(K, crashPoint);

      // ── Betting: bets, bad bets, cancels, re-bets, retries ──
      const live = new Map<string, string>(); // playerId → betId
      for (const playerId of PLAYERS) {
        if (random() < 0.25) continue;
        const betId = ulid('B', ++betCounter);
        const stake = 100 + Math.floor(random() * 4900);
        const auto = random() < 0.5 ? 101 + Math.floor(random() * 1500) : null;
        const effects = table.bet(playerId, betId, stake, auto);
        if (effects.some((e) => e.message.type === 'betPlaced')) {
          bets.set(betId, { playerId, amount: stake, outcome: 'OPEN', payout: 0, resolutions: 0 });
          live.set(playerId, betId);
        }
        if (random() < 0.1) {
          table.bet(playerId, betId, stake, auto); // a retry: replayed, never a second bet
          expect(table.messages('betPlaced')).toEqual([]);
          replays += 1;
        }
        if (random() < 0.05) table.bet(playerId, ulid('B', ++betCounter), 50, null); // refused: too small
        if (live.has(playerId) && random() < 0.1) {
          record(table.cancel(playerId, betId));
          live.delete(playerId);
          if (random() < 0.5) {
            const again = ulid('B', ++betCounter);
            const effects2 = table.bet(playerId, again, 200, null);
            if (effects2.some((e) => e.message.type === 'betPlaced')) {
              bets.set(again, {
                playerId,
                amount: 200,
                outcome: 'OPEN',
                payout: 0,
                resolutions: 0,
              });
              live.set(playerId, again);
            }
          }
        }
      }
      if (previousRoundId !== null && random() < 0.05) {
        table.bet(pick(PLAYERS), ulid('B', ++betCounter), 500, null, previousRoundId); // stale round
        expect(
          table.sentTo(table.last[0]?.kind === 'send' ? table.last[0].playerId : '')[0],
        ).toMatchObject({
          code: 'BETTING_CLOSED',
        });
      }

      // ── Running: presses at random moments, some after the crash, some twice ──
      const presses = [...live.entries()]
        .filter(() => random() < 0.6)
        .map(([playerId, betId]) => ({
          playerId,
          betId,
          at: startedAt + Math.floor(random() * (crashAt - startedAt + 1500)),
        }))
        .sort((a, b) => a.at - b.at);

      for (const press of presses) {
        if (random() < 0.3)
          record(
            table.advance(Math.max(table.now, Math.min(press.at, nextDeadline(table.state).at))),
          );
        const effects = table.cashOut(press.playerId, press.betId, Math.max(table.now, press.at));
        record(effects);
        for (const { message } of effects) {
          if (
            message.type === 'cashOutResult' &&
            message.betId === press.betId &&
            message.reason === 'MANUAL'
          ) {
            manualWins += 1;
            expect(message.multiplier).toBe(multiplierAt(K, table.now - startedAt));
            expect(message.multiplier).toBeLessThan(crashPoint);
          }
          if (message.type === 'error' && message.betId === press.betId) {
            expect(message.code).toBe('TOO_LATE');
            expect(table.now).toBeGreaterThanOrEqual(crashAt);
            lateLosses += 1;
          }
        }
        if (random() < 0.1) record(table.cashOut(press.playerId, press.betId, table.now)); // double press
      }

      while (table.state.round?.phase !== 'CRASHED') {
        const effects = table.advance(Math.max(table.now, nextDeadline(table.state).at));
        record(effects);
        for (const e of effects) {
          if (e.message.type === 'cashOutResult') expect(e.message.reason).toBe('AUTO');
        }
      }

      // ── The reveal verifies, and it is the crash point the round actually used ──
      const crashed = table.state.round;
      if (crashed.phase !== 'CRASHED') throw new Error('not crashed');
      expect(crashed.crashedAt).toBe(crashAt);
      const link = crashed.link;
      if (link === null) throw new Error('a chain round lost its link');
      expect(verifyLink(link.seed, link.previousHash)).toBe(true);
      expect(crashPointOf(link.seed, SALT, CONFIG.houseEdgeBps)).toBe(crashPoint);
      previousRoundId = roundId;
    }

    // ── Whole-run ledger ──
    for (const [betId, bet] of bets) {
      expect({ betId, resolutions: bet.resolutions }).toEqual({ betId, resolutions: 1 });
      expect(bet.outcome).not.toBe('OPEN');
    }
    for (const playerId of PLAYERS) {
      let expected = START;
      for (const bet of bets.values()) {
        if (bet.playerId !== playerId || bet.outcome === 'CANCELLED') continue;
        expected += bet.payout - bet.amount;
      }
      expect(table.balance(playerId)).toBe(expected);
    }
    const staked = [...bets.values()]
      .filter((b) => b.outcome !== 'CANCELLED')
      .reduce((n, b) => n + b.amount, 0);
    const paid = [...bets.values()].reduce((n, b) => n + b.payout, 0);
    expect(table.state.house).toBe(staked - paid);

    // The run exercised what it claims to.
    // The run exercised what it claims to (measured at 62,969 bets · 21,855 manual wins · 3,423 auto
    // cash-outs · 10,718 late presses · 5,990 retries — thresholds sit below, so a change to the
    // driver that stops exercising a path fails here rather than passing quietly).
    expect(bets.size).toBeGreaterThan(50_000);
    expect(manualWins).toBeGreaterThan(15_000);
    expect(autos.size).toBeGreaterThan(2_500);
    expect(lateLosses).toBeGreaterThan(8_000);
    expect(replays).toBeGreaterThan(4_000);
  }, 120_000);
});
