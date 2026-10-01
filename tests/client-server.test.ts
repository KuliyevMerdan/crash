import { CrashClient } from '@crash/client-core';
import { curve, multiplierAt } from '@crash/curve';
import { myBetsOf, roundSnapshotOf } from '@crash/engine';
import { minor } from '@crash/money';
import { createGameServer, memoryStore, readConfig } from '@crash/server';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { lcg, VirtualNet, VirtualTime } from './support/virtual.js';

/**
 * ROADMAP C0 "Done when": the real client core against the real server — `apps/server`'s game loop,
 * store and hub, `packages/client-core` unchanged — in one virtual clock over an in-process network.
 * The connection is cut at 20 random moments across 100 rounds, and after every reconnect the
 * client must hold what the server holds: the phase, the table, its own bets, its balance, and the
 * multiplier it would draw.
 */

function world(latency: { up: number; down: number }, seed: number) {
  const time = new VirtualTime();
  const config = readConfig({
    CRASH_CHAIN_LENGTH: '400',
    CRASH_CHAIN_ROTATE_AT: '50',
    CRASH_BETTING_MS: '1000',
    CRASH_CRASHED_MS: '500',
    CRASH_GROWTH_RATE: '1',
    CRASH_DEV_CHAIN_SEED: '0c'.repeat(32),
  });
  const server = createGameServer({
    config,
    store: memoryStore(),
    log: pino({ level: 'silent' }),
    clock: time.clock,
    scheduler: time,
    random: lcg(seed + 1),
  });
  server.start();
  const net = new VirtualNet(time, server.hub, latency);
  const client = new CrashClient({
    transport: net,
    clock: time.clock,
    scheduler: time,
    nick: 'ada',
    random: lcg(seed + 2),
    backoff: { initialMs: 200, maxMs: 2000 },
  });
  return { time, config, server, net, client, curve: curve(config.game.curve.growthRatePerSecond) };
}

type World = ReturnType<typeof world>;

/** The client's view, held against the server's truth at this moment. */
function expectInSync(w: World): void {
  const view = w.client.getState().game;
  if (view === null) throw new Error('no view');
  const truth = w.server.game.snapshot;
  const round = roundSnapshotOf(truth);
  expect(view.round).toEqual(round);
  expect(view.myBets).toEqual(myBetsOf(truth, view.player.id));
  expect(view.player.balance).toBe(truth.players.get(view.player.id)?.balance);
  if (round?.phase === 'RUNNING') {
    expect(w.client.multiplier()).toBe(multiplierAt(w.curve, w.time.now - round.startedAt));
  }
}

/** A player with a habit: bets every round, half the time with an auto cash-out, else presses. */
function play(w: World, random: () => number): () => void {
  let busy = false;
  return () => {
    const state = w.client.getState();
    const view = state.game;
    if (state.status !== 'live' || view === null || busy) return;
    const mine = view.myBets[0];
    if (view.round.phase === 'BETTING' && mine === undefined) {
      busy = true;
      const auto = random() < 0.5 ? 110 + Math.floor(random() * 300) : null;
      void w.client
        .placeBet(minor(100 + Math.floor(random() * 400)), auto)
        .then(() => (busy = false));
    } else if (
      view.round.phase === 'RUNNING' &&
      mine?.status === 'OPEN' &&
      mine.autoCashOutAt === null &&
      random() < 0.02
    ) {
      busy = true;
      void w.client.cashOut(mine.betId).then(() => (busy = false));
    }
  };
}

describe('the client core against the real server, in virtual time', () => {
  it('lands every one of 20 reconnects across 100 rounds in the server’s phase, bets, balance and multiplier', async () => {
    const w = world({ up: 0, down: 0 }, 42);
    const random = lcg(2026);
    const act = play(w, random);
    w.client.start();

    // Twenty rounds, chosen at random, each cut at a random moment after it opens — the cuts take
    // turns aiming at BETTING, RUNNING and CRASHED, since the pause is too short for chance alone.
    const cutRounds = new Set<number>();
    while (cutRounds.size < 20) cutRounds.add(1 + Math.floor(random() * 99));
    let rounds = 0;
    let lastRoundId = '';
    const PHASES = ['BETTING', 'RUNNING', 'CRASHED'] as const;
    const cuts: Array<{ due: number; phase: (typeof PHASES)[number] }> = [];
    let scheduled = 0;
    let performed = 0;
    const cutPhases = new Set<string>();
    let checks = 0;

    w.client.subscribe((_state, event) => {
      if (event.type === 'hello' && w.net.links > 1) {
        expectInSync(w);
        checks += 1;
      }
    });

    while (rounds < 100 || performed < 20) {
      w.time.advance(10);
      await Promise.resolve(); // let request promises settle between steps
      act();

      const roundId = w.server.game.snapshot.round?.roundId ?? '';
      if (roundId !== lastRoundId) {
        lastRoundId = roundId;
        rounds += 1;
        if (cutRounds.has(rounds)) {
          cuts.push({
            due: w.time.now + Math.floor(random() * 3000),
            phase: PHASES[scheduled % 3] ?? 'BETTING',
          });
          scheduled += 1;
        }
      }
      // A cut due while the client is still reconnecting waits until it is live again — there is no
      // connection to cut — so all twenty land, in whatever round they fall.
      const next = cuts[0];
      if (
        next !== undefined &&
        w.time.now >= next.due &&
        w.server.game.snapshot.round?.phase === next.phase &&
        w.client.getState().status === 'live'
      ) {
        cuts.shift();
        cutPhases.add(w.server.game.snapshot.round?.phase ?? '?');
        w.net.cut();
        performed += 1;
      }
      if (w.client.getState().status === 'live') expectInSync(w);
    }

    expect(checks).toBe(20); // one hello-time check per reconnect
    expect([...cutPhases].sort()).toEqual(['BETTING', 'CRASHED', 'RUNNING']);
    expect(w.net.links).toBe(21);

    // Over the whole run the money agrees, and the player really played.
    const truth = w.server.game.snapshot;
    const view = w.client.getState().game;
    expect(view?.player.balance).toBe(truth.players.get(view?.player.id ?? '')?.balance);
    expect(truth.house).not.toBe(0);
  });

  it('with 40 ms up and 120 ms down: the multiplier off by exactly the clock estimate, and the view settles to the truth', async () => {
    const w = world({ up: 40, down: 120 }, 7);
    const act = play(w, lcg(99));
    w.client.start();
    let rounds = 0;
    let lastRoundId = '';
    let drawnChecks = 0;

    while (rounds < 30) {
      w.time.advance(10);
      await Promise.resolve();
      act();
      const truth = w.server.game.snapshot;
      const round = truth.round;
      if (round && round.roundId !== lastRoundId) {
        lastRoundId = round.roundId;
        rounds += 1;
        if (rounds === 12) w.net.cut();
      }
      // The client draws exactly m(now + offset − startedAt): its only error is its clock estimate,
      // and that error is half the latency asymmetry — (40 − 120)/2 = −40 ms — which no sampling
      // can see (§8). So the drawn number trails the server's by the curve's rise over 40 ms.
      const drawn = w.client.multiplier();
      const offset = w.client.getState().clock.offset;
      if (
        round?.phase === 'RUNNING' &&
        drawn !== null &&
        offset !== null &&
        w.client.getState().game?.round.phase === 'RUNNING'
      ) {
        expect(drawn).toBe(multiplierAt(w.curve, w.time.now + offset - round.startedAt));
        expect(Math.abs(offset)).toBeLessThanOrEqual(Math.abs(40 - 120) / 2);
        drawnChecks += 1;
      }
      // Quiet moment: 300 ms into the pause after a crash, nothing in flight.
      if (
        round?.phase === 'CRASHED' &&
        w.time.now - round.crashedAt >= 300 &&
        w.time.now - round.crashedAt < 310
      ) {
        expectInSync(w);
      }
    }
    expect(w.client.getState().clock.offset).toBe(-40);
    expect(w.client.getState().clock.rtt).toBe(160);
    expect(drawnChecks).toBeGreaterThan(100);
  });
});
