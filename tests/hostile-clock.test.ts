import { curve, multiplierAt } from '@crash/curve';
import { parseServerMessage, type ServerMessage } from '@crash/protocol';
import { createGameServer, memoryStore, readConfig } from '@crash/server';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { VirtualTime } from './support/virtual.js';

/**
 * ROADMAP P0, hostile clocks: a client that lies about time — the one thing it can send that is a
 * time at all is `ping.clientTime` (docs/protocol.md §8) — cannot move a payout by a hundredth.
 * Cash-out is judged on the server's receive time and nothing else (ADR-0002). Two players press at
 * the same server moment, one honest and one that has just sent pings from the epoch and from the
 * end of time; both are paid the curve at that moment, exactly.
 */
function player(server: ReturnType<typeof createGameServer>) {
  const heard: ServerMessage[] = [];
  const attached = server.hub.attach({
    send: (frame) => {
      const outcome = parseServerMessage(JSON.parse(frame));
      if (outcome.kind === 'ok') heard.push(outcome.message);
    },
    terminate: () => {},
    isOpen: true,
  });
  return {
    heard,
    send: (message: object) => attached.receive(JSON.stringify(message)),
    last: <T extends ServerMessage['type']>(type: T) =>
      heard.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1),
  };
}

describe('hostile clocks (ROADMAP P0)', () => {
  it('a client lying about its clock is paid exactly what an honest one is, at the same moment', () => {
    const time = new VirtualTime();
    const config = readConfig({ CRASH_BETTING_MS: '1000', CRASH_CRASHED_MS: '500' });
    const server = createGameServer({
      config,
      store: memoryStore(),
      log: pino({ level: 'silent' }),
      clock: time.clock,
      scheduler: time,
    });
    server.start();
    const honest = player(server);
    const liar = player(server);
    honest.send({ type: 'authenticate', token: null, nick: 'honest' });
    liar.send({ type: 'authenticate', token: null, nick: 'liar' });
    liar.send({ type: 'devForceCrashPoint', crashPoint: 5000 }); // the next round climbs to 50×

    for (let i = 0; i < 400 && honest.last('bettingOpen')?.chainIndex !== null; i += 1) {
      time.advance(10);
    }
    const open = honest.last('bettingOpen');
    if (open === undefined) throw new Error('no forced round opened');
    const bet = (who: typeof honest, betId: string) =>
      who.send({
        type: 'placeBet',
        betId,
        roundId: open.roundId,
        amount: 1000,
        autoCashOutAt: null,
      });
    bet(honest, '01J8ZQ4Y6T3M9N2B7C5D1E0F0A');
    bet(liar, '01J8ZQ4Y6T3M9N2B7C5D1E0F0B');
    time.advance(1000);
    const started = honest.last('roundStart');
    if (started === undefined) throw new Error('the round did not start');

    time.advance(started.startedAt + 3217 - time.now); // an arbitrary moment mid-climb
    liar.send({ type: 'ping', clientTime: 0 });
    liar.send({ type: 'ping', clientTime: Number.MAX_SAFE_INTEGER });
    liar.send({ type: 'cashOut', betId: '01J8ZQ4Y6T3M9N2B7C5D1E0F0B' });
    honest.send({ type: 'cashOut', betId: '01J8ZQ4Y6T3M9N2B7C5D1E0F0A' });

    const truth = multiplierAt(curve(config.game.curve.growthRatePerSecond), 3217);
    expect(liar.last('pong')?.serverTime).toBe(time.now); // its lies are only ever echoed back
    expect(liar.last('cashOutResult')).toMatchObject({
      multiplier: truth,
      payout: ((1000 * truth) / 100) | 0,
    });
    expect(honest.last('cashOutResult')?.multiplier).toBe(truth);
    server.stop();
  });
});
