import { auditMoney, myBetsOf, roundSnapshotOf, type EngineState } from '@crash/engine';
import { Population, type Truth } from '@crash/load';
import { createGameServer, memoryStore, readConfig } from '@crash/server';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { lcg, VirtualNet, VirtualTime } from './support/virtual.js';

/**
 * ROADMAP P0, in virtual time: a crowd of real `client-core` players against the real game server
 * (`createGameServer` — the loop, the hub with its fault lanes, the store), for as many virtual
 * minutes as the run is given, while the network does everything a real crowd's does to it:
 *
 * - a fifth of the crowd on a 300 ms link and a fifth on a lossy one (20% of frames resent, D17);
 * - a tenth with a clock an hour off, either way;
 * - every 20 s, 3% of links frozen for 3 s; every 45 s, 1% gone dark without a close;
 * - every 2½ minutes, mid-round, 40% of the crowd dropped by the server at once — a reconnect storm.
 *
 * Money is audited every virtual second: every minor unit ever granted is in a wallet, a stake
 * still riding, or the house. At the end the faults stop, the crowd settles, and every client is
 * held to the server's own account of it: live, the same round, history, wallet and bets.
 *
 * CI runs 200 players for 10 minutes; `SOAK_PLAYERS` / `SOAK_MINUTES` run it bigger by hand.
 * `pnpm load` is the same crowd over real sockets, against a real process, in real time.
 */
const PLAYERS = Number(process.env['SOAK_PLAYERS'] ?? 200);
const MINUTES = Number(process.env['SOAK_MINUTES'] ?? 10);

function truthOf(s: EngineState): Truth {
  const round = roundSnapshotOf(s);
  if (round === null) throw new Error('no round yet');
  const money = auditMoney(s);
  return {
    money,
    round,
    history: s.history,
    players: new Map(
      [...s.players.values()].map((p) => [p.id, { balance: p.balance, myBets: myBetsOf(s, p.id) }]),
    ),
  };
}

describe('the soak (ROADMAP P0, virtual time)', () => {
  it(`${PLAYERS} players, ${MINUTES} minutes of faults: no money made or lost, nobody in a wrong state`, async () => {
    const time = new VirtualTime();
    const config = readConfig({
      CRASH_DEV_CHAIN_SEED: '5a'.repeat(32),
      CRASH_CHAIN_LENGTH: '5000',
      CRASH_CHAIN_ROTATE_AT: '500',
    });
    const server = createGameServer({
      config,
      store: memoryStore(),
      log: pino({ level: 'silent' }),
      clock: time.clock,
      scheduler: time,
      random: lcg(11),
    });
    server.start();
    const crowd = new Population({
      size: PLAYERS,
      link: () => new VirtualNet(time, server.hub, { up: 5, down: 5 }),
      clock: time.clock,
      scheduler: time,
      random: lcg(2026),
      arrivalMs: 5000,
    });
    crowd.sampling = false;
    crowd.start();

    // The money law, every virtual second.
    const breaches: string[] = [];
    let audits = 0;
    time.setInterval(() => {
      const { granted, accounted } = auditMoney(server.game.snapshot);
      audits += 1;
      if (granted !== accounted)
        breaches.push(`at ${time.now}: granted ${granted}, accounted ${accounted}`);
    }, 1000);

    // The faults.
    const every = (ms: number, fn: () => void) => {
      const timer = time.setInterval(fn, ms);
      return () => timer.cancel();
    };
    const stalls = every(20_000, () => crowd.stall(crowd.pick(0.03), 3000));
    const darks = every(45_000, () => crowd.blackhole(crowd.pick(0.01)));
    let storms = 0;
    const stormer = every(150_000, () => {
      const at = () => {
        if (server.game.snapshot.round?.phase !== 'RUNNING') {
          time.setTimeout(at, 50); // wait for the multiplier to be climbing
          return;
        }
        storms += 1;
        crowd.storm(crowd.pick(0.4));
      };
      at();
    });

    // In steps, settling the promises between them: a bet's outcome — and the cancel some players
    // follow it with — arrives as a resolved promise, which no synchronous `advance` lets run.
    const run = async (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        time.advance(50);
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await run(MINUTES * 60_000);

    // Settle: no new faults, no new bets; dark links noticed (15 s) and replaced; a fresh round.
    stalls();
    darks();
    stormer();
    crowd.quiesce();
    await run(30_000);
    const s = () => server.game.snapshot;
    for (let guard = 0; guard < 400 && s().round?.phase !== 'BETTING'; guard += 1) await run(100);
    await run(1000); // the bettingOpen has landed everywhere; nobody is betting

    const truth = truthOf(s());
    expect(breaches).toEqual([]);
    expect(truth.money.accounted).toBe(truth.money.granted);
    expect(crowd.compare(truth)).toEqual([]);

    if (process.env['SOAK_DEBUG'])
      console.log(JSON.stringify({ storms, audits, tally: crowd.tally }, null, 1));
    // The run was not vacuous: the crowd played, and every fault actually happened.
    const all = Object.values(crowd.tally);
    const sum = (f: (t: (typeof all)[number]) => number) => all.reduce((a, t) => a + f(t), 0);
    expect(audits).toBeGreaterThanOrEqual(MINUTES * 60);
    expect(storms).toBeGreaterThanOrEqual(Math.floor(MINUTES / 2.5));
    expect(sum((t) => t.accepted)).toBeGreaterThan(PLAYERS * MINUTES);
    expect(sum((t) => t.manual)).toBeGreaterThan(0);
    expect(sum((t) => t.auto)).toBeGreaterThan(0);
    expect(sum((t) => t.cancelled)).toBeGreaterThan(0);
    expect(sum((t) => t.reconnects)).toBeGreaterThan(storms * PLAYERS * 0.3);
    expect(crowd.bots.some((b) => b.skewMs !== 0)).toBe(true);
    crowd.stop();
    server.stop();
  }, 300_000);
});
