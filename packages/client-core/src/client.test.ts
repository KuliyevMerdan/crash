import { curve, multiplierAt } from '@crash/curve';
import { minor } from '@crash/money';
import { describe, expect, it } from 'vitest';
import {
  COMMIT,
  FakeServer,
  NEXT_ROUND,
  ROUND,
  VirtualTime,
  betting,
  hello,
} from './__fixtures__/fake.js';
import { CrashClient, type ClientEvent, type ClientOptions } from './index.js';

const K = curve(0.15);

function setup(options: Partial<ClientOptions> & { skew?: number } = {}) {
  const time = new VirtualTime();
  const server = new FakeServer(time);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const tokens: string[] = [];
  const events: ClientEvent[] = [];
  const client = new CrashClient({
    transport: server,
    clock: time.clock(options.skew ?? 0),
    scheduler: time,
    nick: 'ada',
    random,
    onToken: (t) => tokens.push(t),
    ...options,
  });
  client.subscribe((_s, e) => events.push(e));
  client.start();
  return { time, server, client, tokens, events };
}

/** Connect and answer the authenticate with `h`. */
function login(t: ReturnType<typeof setup>, h = hello(betting(Date.UTC(2030, 0)))) {
  t.time.advance(2 * t.server.up + 10); // the socket opens, then the authenticate travels up
  expect(t.server.sent('authenticate').at(-1)).toMatchObject({ type: 'authenticate', nick: 'ada' });
  t.server.send(h);
  t.time.advance(t.server.down + 10);
}

describe('connecting', () => {
  it('authenticates with no token, goes live on hello, and hands the issued token to the caller', () => {
    const t = setup();
    expect(t.client.getState().status).toBe('connecting');
    login(t);
    expect(t.server.sent('authenticate')[0]?.token).toBeNull();
    expect(t.client.getState()).toMatchObject({
      status: 'live',
      game: { player: { balance: 100_000 } },
    });
    expect(t.tokens).toEqual(['tok_1']);
  });

  it('starts over with a new wallet when the server does not know its token', () => {
    const t = setup({ token: 'stale' });
    t.time.advance(10);
    expect(t.server.sent('authenticate')[0]?.token).toBe('stale');
    t.server.send({ type: 'error', class: 'SESSION', code: 'SESSION_INVALID', message: 'unknown' });
    t.time.advance(10);
    expect(t.server.sent('authenticate')[1]?.token).toBeNull();
    expect(t.events).toContainEqual({ type: 'session-reset' });
  });
});

describe('clock sync (§8)', () => {
  it('finds a clock an hour off, to within half the latency asymmetry', () => {
    // The client's clock runs an hour behind; the uplink takes 30 ms and the downlink 90.
    const t = setup({ skew: -3_600_000 });
    t.server.up = 30;
    t.server.down = 90;
    login(t);
    t.time.advance(2000); // the five-ping burst after hello
    const { offset, rtt } = t.client.getState().clock;
    expect(rtt).toBe(120);
    // Truth is +3,600,000. Every sample is off by (up − down)/2 = −30, and no estimate can see it.
    expect(offset).toBe(3_600_000 - 30);
    expect(Math.abs((offset ?? 0) - 3_600_000)).toBeLessThanOrEqual(Math.abs(30 - 90) / 2);
  });

  it('sends whole milliseconds even when its own clock is fractional, as a browser’s is', () => {
    // performance.timeOrigin + performance.now() is never an integer; the protocol's timestamps are.
    const t = setup({ skew: 0.37 });
    login(t);
    t.time.advance(2000);
    const pings = t.server.sent('ping');
    expect(pings.length).toBeGreaterThanOrEqual(5);
    for (const ping of pings) expect(Number.isInteger(ping.clientTime)).toBe(true);
    expect(t.client.getState().clock.rtt).not.toBeNull();
  });

  it('draws the multiplier from startedAt on the server’s clock — joining a round already running', () => {
    const t = setup({ skew: 12_345 });
    const serverNow = t.time.now;
    const startedAt = serverNow - 4621; // the round reached 2.00× before this client existed
    login(t, hello({ roundId: ROUND, chainIndex: 5, phase: 'RUNNING', startedAt, bets: [] }));
    t.time.advance(1000);
    expect(t.client.getState().clock.offset).toBe(-12_345);
    expect(t.client.multiplier()).toBe(multiplierAt(K, t.time.now - startedAt));
    expect(t.client.multiplier()).toBeGreaterThan(200);
  });

  it('predicts where a press will land half a round trip later (ADR-0002)', () => {
    const t = setup();
    t.server.up = 150;
    t.server.down = 150;
    login(
      t,
      hello({
        roundId: ROUND,
        chainIndex: 5,
        phase: 'RUNNING',
        startedAt: 1_755_400_000_000,
        bets: [],
      }),
    );
    t.time.advance(3000);
    const now = t.client.multiplier() ?? 0;
    const landing = t.client.landingMultiplier() ?? 0;
    expect(landing).toBe(multiplierAt(K, t.time.now + 150 - 1_755_400_000_000));
    expect(landing).toBeGreaterThanOrEqual(now);
  });
});

describe('the view', () => {
  it('applies a duplicate betAccepted once — the replay’s balance is as old as the original', async () => {
    const t = setup();
    login(t);
    const pending = t.client.placeBet(minor(500), 200);
    t.time.advance(10);
    const { betId } = t.server.sent('placeBet')[0] ?? { betId: '' };
    const accepted = {
      type: 'betAccepted',
      roundId: ROUND,
      betId,
      amount: 500,
      autoCashOutAt: 200,
      balance: 99_500,
    };
    t.server.send(accepted);
    t.server.send({ type: 'betCancelled', roundId: ROUND, betId, balance: 100_000 });
    t.server.send(accepted); // a late replay of the original reply
    t.time.advance(10);
    expect((await pending).ok).toBe(true);
    expect(t.client.getState().game).toMatchObject({ player: { balance: 100_000 }, myBets: [] });
  });

  it('asks for a fresh hello when a message names a round it does not know', () => {
    const t = setup();
    login(t);
    t.server.send({ type: 'roundStart', roundId: NEXT_ROUND, startedAt: 1 });
    t.time.advance(10);
    expect(t.events).toContainEqual({ type: 'resync', cause: 'roundStart' });
    expect(t.server.sent('authenticate')).toHaveLength(2);
  });

  it('flags a tick that disagrees with the local curve by more than a step', () => {
    const t = setup();
    login(t, hello({ roundId: ROUND, chainIndex: 5, phase: 'RUNNING', startedAt: 1, bets: [] }));
    t.server.send({ type: 'tick', roundId: ROUND, elapsedMs: 3400, multiplier: 166 });
    t.server.send({ type: 'tick', roundId: ROUND, elapsedMs: 3400, multiplier: 170 });
    t.time.advance(10);
    expect(t.events.filter((e) => e.type === 'drift')).toEqual([
      { type: 'drift', expected: 166, received: 170 },
    ]);
  });

  it('reports a frame that breaks the contract instead of swallowing it', () => {
    const t = setup();
    login(t);
    t.server.send({ type: 'tick', roundId: ROUND, elapsedMs: 1, multiplier: 1.5 });
    t.time.advance(10);
    expect(t.events).toContainEqual(
      expect.objectContaining({ type: 'protocol-error', frameType: 'tick' }),
    );
  });
});

describe('requests are intents with one betId (§7)', () => {
  it('sends the same message again after a timeout, and settles on the first answer', async () => {
    const t = setup({ requestTimeoutMs: 1000 });
    login(t);
    const pending = t.client.placeBet(minor(500));
    t.time.advance(2500);
    const sends = t.server.sent('placeBet');
    expect(sends).toHaveLength(3);
    expect(new Set(sends.map((s) => s.betId)).size).toBe(1);
    const betId = sends[0]?.betId ?? '';
    t.server.send({
      type: 'betAccepted',
      roundId: ROUND,
      betId,
      amount: 500,
      autoCashOutAt: null,
      balance: 99_500,
    });
    t.time.advance(5000);
    expect(await pending).toMatchObject({ ok: true, betId, reply: { type: 'betAccepted' } });
    expect(t.server.sent('placeBet')).toHaveLength(3); // settled: no more sends
  });

  it('retries a SYSTEM refusal under the same betId, and ends on a PLAYER one', async () => {
    const t = setup();
    login(t);
    const pending = t.client.placeBet(minor(500));
    t.time.advance(10);
    const betId = t.server.sent('placeBet')[0]?.betId ?? '';
    t.server.send({ type: 'error', class: 'SYSTEM', code: 'UNAVAILABLE', message: 'x', betId });
    t.time.advance(400);
    expect(t.server.sent('placeBet').map((m) => m.betId)).toEqual([betId, betId]);
    t.server.send({
      type: 'error',
      class: 'PLAYER',
      code: 'INSUFFICIENT_FUNDS',
      message: 'x',
      roundId: ROUND,
      betId,
    });
    t.time.advance(10);
    expect(await pending).toMatchObject({
      ok: false,
      betId,
      error: { code: 'INSUFFICIENT_FUNDS' },
    });
  });

  it('carries a pending request across a reconnect and asks again after the new hello', async () => {
    const t = setup();
    login(t);
    const pending = t.client.cashOut('01J8ZQ5A1B2C3D4E5F6G7H8J9K');
    t.time.advance(5);
    t.server.drop();
    t.time.advance(1000);
    t.server.send(hello(betting(1)));
    t.time.advance(10);
    const presses = t.server.sent('cashOut');
    expect(presses.map((p) => p.betId)).toEqual([
      '01J8ZQ5A1B2C3D4E5F6G7H8J9K',
      '01J8ZQ5A1B2C3D4E5F6G7H8J9K',
    ]);
    t.client.close();
    expect(await pending).toMatchObject({ ok: false, reason: 'closed' });
  });
});

describe('staying connected', () => {
  it('backs off exponentially between failed attempts, and resets once live', () => {
    const t = setup({ backoff: { initialMs: 100, maxMs: 1000 } });
    login(t);
    t.server.refuse = true;
    const attemptsAt: number[] = [];
    t.client.subscribe((_s, e) => {
      if (e.type === 'status' && e.status === 'connecting') attemptsAt.push(t.time.now);
    });
    const droppedAt = t.time.now;
    t.server.drop();
    t.time.advance(5000);
    const gaps = attemptsAt.map((at, i) => at - (attemptsAt[i - 1] ?? droppedAt));
    expect(gaps.slice(0, 5).map((g) => Math.round(g / 10) * 10)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    for (const [i, gap] of gaps.slice(0, 5).entries()) {
      const nominal = Math.min(1000, 100 * 2 ** i);
      expect(gap).toBeGreaterThanOrEqual(nominal * 0.8 - 1);
      expect(gap).toBeLessThanOrEqual(nominal * 1.2 + 1);
    }
    t.server.refuse = false;
    t.time.advance(1500);
    t.server.send(hello(betting(1)));
    t.time.advance(10);
    expect(t.client.getState().status).toBe('live');
  });

  it('treats three missed pongs as a dead socket, even one that never said so', () => {
    const t = setup({ pingIntervalMs: 1000 });
    login(t);
    t.time.advance(2000);
    const before = t.server.connections;
    t.server.autoPong = false; // half-open: frames go out, nothing comes back, no close
    t.time.advance(4500); // three intervals, plus the ping that notices
    expect(t.client.getState().status).not.toBe('live');
    t.time.advance(2000);
    expect(t.server.connections).toBe(before + 1);
  });

  it('gives up on a socket that opens and then never answers the authenticate', () => {
    // Liveness runs on pings, and pings start at hello — so a link that goes dark between the open
    // and the hello would leave the client "joining" forever without a deadline of its own.
    const t = setup({ pingIntervalMs: 1000 });
    t.time.advance(2 * t.server.up + 10);
    expect(t.client.getState().status).toBe('authenticating');
    t.time.advance(2900);
    expect(t.server.connections).toBe(1); // still within three intervals
    t.time.advance(200);
    expect(t.client.getState().status).toBe('reconnecting');
    t.time.advance(1000);
    expect(t.server.connections).toBe(2);
    login(t);
    expect(t.client.getState().status).toBe('live');
    t.time.advance(10_000); // and the deadline is gone once live: pings keep it
    expect(t.server.connections).toBe(2);
  });

  it('sends a dev message down its own socket while it has one, and says when it has none', () => {
    const t = setup();
    login(t);
    expect(t.client.sendDev({ type: 'devStall', ms: 3000 })).toBe(true);
    t.time.advance(t.server.up + 1);
    expect(t.server.sent('devStall')).toEqual([{ type: 'devStall', ms: 3000 }]);
    t.server.drop();
    t.time.advance(1);
    expect(t.client.sendDev({ type: 'devDisconnect' })).toBe(false);
  });

  it('keeps the last view through a drop — stale, not blank — until the next hello', () => {
    const t = setup();
    login(t);
    t.server.drop();
    t.time.advance(1);
    expect(t.client.getState()).toMatchObject({
      status: 'reconnecting',
      game: { chain: { commit: COMMIT } },
    });
  });
});
