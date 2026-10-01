import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { curve, elapsedAt } from '@crash/curve';
import { crashPoint as crashPointOf, verifyToCommit } from '@crash/fair';
import { chainListing, revealedRound } from '@crash/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  betId,
  Client,
  devSeedWithFirstCrashAtLeast,
  sleep,
  start,
  testConfig,
  type Running,
} from './__fixtures__/harness.js';
import { sqliteStore } from './store/sqlite.js';

const DEV_SEED = devSeedWithFirstCrashAtLeast(400); // round 1 runs ≥ 1.4 s at k = 1
const dir = mkdtempSync(path.join(tmpdir(), 'crash-server-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const dbFile = () => path.join(dir, `server-${++files}.db`);

const open: Array<Running | Client> = [];
afterEach(async () => {
  for (const thing of open.splice(0).reverse()) {
    if (thing instanceof Client) thing.close();
    else await thing.close();
  }
});
async function run(...args: Parameters<typeof start>): Promise<Running> {
  const running = await start(...args);
  open.push(running);
  return running;
}
async function connect(running: Running): Promise<Client> {
  const client = await Client.connect(running.ws);
  open.push(client);
  return client;
}
async function getJson(url: string): Promise<unknown> {
  return (await fetch(url)).json();
}

describe('two players in one round (ROADMAP S3 "Done when")', () => {
  it('one cashes out, one busts, and the reveal verifies against the published commit', async () => {
    const config = testConfig({ CRASH_DEV_CHAIN_SEED: DEV_SEED, CRASH_BETTING_MS: '800' });
    const server = await run(config);
    const ada = await connect(server);
    const bo = await connect(server);
    const [helloA, helloB] = await Promise.all([ada.login('ada'), bo.login('bo')]);

    expect(helloA.round.phase).toBe('BETTING');
    expect(helloB.round.roundId).toBe(helloA.round.roundId);
    const roundId = helloA.round.roundId;
    const [betA, betB] = [betId(), betId()];
    ada.send({ type: 'placeBet', betId: betA, roundId, amount: 1000, autoCashOutAt: null });
    bo.send({ type: 'placeBet', betId: betB, roundId, amount: 1000, autoCashOutAt: null });
    expect(await ada.next('betAccepted')).toMatchObject({ betId: betA, balance: 99_000 });
    expect(await bo.next('betAccepted')).toMatchObject({ betId: betB, balance: 99_000 });
    await bo.next('betPlaced', (m) => m.betId === betA); // each sees the other's stake

    const started = await ada.next('roundStart');
    await sleep(250);
    ada.send({ type: 'cashOut', betId: betA });
    const won = await ada.next('cashOutResult');
    expect(won).toMatchObject({ betId: betA, reason: 'MANUAL' });
    await bo.next('playerCashedOut', (m) => m.betId === betA);

    const [crashA, crashB] = await Promise.all([ada.next('crash'), bo.next('crash')]);
    expect(crashB).toEqual(crashA);
    expect(crashA.settled).toEqual([
      { betId: betA, nick: 'ada', won: true },
      { betId: betB, nick: 'bo', won: false },
    ]);
    expect(crashA.crashedAt - started.startedAt).toBe(elapsedAt(curve(1), crashA.crashPoint));
    expect(won.multiplier).toBeLessThan(crashA.crashPoint);

    // Verify it the way a stranger would: the published commit, the formula, the chain walk.
    const { chains } = chainListing.parse(await getJson(`${server.url}/fair/chains`));
    const chain = chains[0];
    const fair = crashA.fair;
    if (chain === undefined || fair === null) throw new Error('no chain or no reveal');
    expect(verifyToCommit(fair.seed, fair.chainIndex, chain.commit)).toBe(true);
    expect(crashPointOf(fair.seed, chain.salt, chain.houseEdgeBps)).toBe(crashA.crashPoint);
    expect(revealedRound.parse(await getJson(`${server.url}/fair/1/${fair.chainIndex}`))).toEqual({
      ...fair,
      crashPoint: crashA.crashPoint,
      roundId,
    });
    const next = await ada.next('bettingOpen');
    expect(next.chainIndex).toBe(fair.chainIndex + 1);

    // A latecomer's history points at that reveal by its place in the chain (D16) — the strip's link.
    const cy = await connect(server);
    const helloC = await cy.login('cy');
    expect(helloC.history[0]).toEqual({
      roundId,
      crashPoint: crashA.crashPoint,
      link: { chainId: chain.id, chainIndex: fair.chainIndex },
    });

    // …and nothing the server logged before the crash carried the seed; s₀ was never logged at all.
    const crashLine = server.lines.findIndex((l) => l.includes('"msg":"round crashed"'));
    expect(server.lines.slice(0, crashLine).join('\n')).not.toContain(fair.seed);
    expect(server.lines.join('\n')).not.toContain(DEV_SEED);
  }, 20_000);
});

describe('a restart resumes the round and the chain', () => {
  it('mid-round: the same round, the same bet, the same balance — and the chain carries on', async () => {
    const file = dbFile();
    const config = testConfig({ CRASH_DEV_CHAIN_SEED: DEV_SEED, CRASH_BETTING_MS: '800' });
    const first = await start(config, sqliteStore(file));
    const ada = await Client.connect(first.ws);
    const hello = await ada.login('ada');
    const bet = betId();
    ada.send({
      type: 'placeBet',
      betId: bet,
      roundId: hello.round.roundId,
      amount: 1000,
      autoCashOutAt: null,
    });
    await ada.next('betAccepted');
    await ada.next('roundStart');
    const commit = first.server.chains.info().commit;
    ada.close();
    await first.close(); // the process dies mid-round

    const second = await run(config, sqliteStore(file));
    expect(second.server.chains.info().commit).toBe(commit); // never regenerated
    const back = await connect(second);
    const resumed = await back.login('ada', hello.token);
    expect(resumed.round).toMatchObject({ roundId: hello.round.roundId, phase: 'RUNNING' });
    expect(resumed.myBets).toEqual([expect.objectContaining({ betId: bet, status: 'OPEN' })]);
    expect(resumed.player.balance).toBe(99_000);

    back.send({ type: 'cashOut', betId: bet });
    const won = await back.next('cashOutResult');
    const crash = await back.next('crash');
    expect(crash.fair?.chainIndex).toBe(1);
    expect(won.multiplier).toBeLessThan(crash.crashPoint);
    expect(verifyToCommit(crash.fair?.seed ?? '', 1, commit)).toBe(true);
    expect((await back.next('bettingOpen')).chainIndex).toBe(2);
  }, 20_000);

  it('after the crash moment passed while down: auto cash-outs and the bust settle at their scheduled moments', async () => {
    const file = dbFile();
    const config = testConfig({ CRASH_DEV_CHAIN_SEED: DEV_SEED, CRASH_BETTING_MS: '800' });
    const first = await start(config, sqliteStore(file));
    const ada = await Client.connect(first.ws);
    const hello = await ada.login('ada');
    const bet = betId();
    ada.send({
      type: 'placeBet',
      betId: bet,
      roundId: hello.round.roundId,
      amount: 1000,
      autoCashOutAt: 150,
    });
    await ada.next('betAccepted');
    await ada.next('roundStart');
    ada.close();
    await first.close();
    await sleep(elapsedAt(curve(1), 1200) + 200); // past any crash point the dev seed's round 1 can have

    const second = await run(config, sqliteStore(file));
    const back = await connect(second);
    const resumed = await back.login('ada', hello.token);
    expect(resumed.player.balance).toBe(99_000 + 1500); // the 1.50× auto cash-out fired while down
    expect(resumed.history[0]?.roundId).toBe(hello.round.roundId);
    const reveal = revealedRound.parse(await getJson(`${second.url}/fair/1/1`));
    expect(reveal.roundId).toBe(hello.round.roundId);
  }, 20_000);
});

describe('the dev surface (docs/protocol.md §9)', () => {
  it('a production server drops a hand-crafted devForceCrashPoint — the next round is a chain round', async () => {
    const config = testConfig({
      CRASH_ENV: 'production',
      CRASH_DB: dbFile(),
      CRASH_GROWTH_RATE: '20',
    });
    const server = await run(config, sqliteStore(config.database));
    const ada = await connect(server);
    await ada.login('ada');
    ada.send({ type: 'devForceCrashPoint', crashPoint: 5000 });
    ada.send({ type: 'devFaults', latencyMs: 0, dropRate: 1 }); // faults are off too
    const opened = await ada.next('bettingOpen');
    expect(opened.chainIndex).not.toBeNull();
    const crash = await ada.next('crash', (m) => m.roundId === opened.roundId);
    expect(crash.fair).not.toBeNull();
    expect(ada.received.some((m) => m.type === 'error')).toBe(false); // dropped, not answered
    const dropped = server.lines.filter((l) => l.includes('unknown message type dropped'));
    expect(dropped.map((l) => JSON.parse(l).type)).toEqual(['devForceCrashPoint', 'devFaults']);
  });

  it('a development server forces the next round, which claims no chain link', async () => {
    const config = testConfig({ CRASH_GROWTH_RATE: '5' });
    const server = await run(config);
    const ada = await connect(server);
    await ada.login('ada');
    ada.send({ type: 'devForceCrashPoint', crashPoint: 250 });
    const forced = await ada.next('bettingOpen', (m) => m.chainIndex === null);
    const crash = await ada.next('crash', (m) => m.roundId === forced.roundId);
    expect(crash).toMatchObject({ crashPoint: 250, fair: null });
    const after = await ada.next('bettingOpen');
    const consumed = server.server.chains.info();
    expect(after.chainIndex).not.toBeNull();
    expect(consumed.id).toBe(1);
    const bo = await connect(server);
    const history = (await bo.login('bo')).history;
    expect(history.find((h) => h.roundId === forced.roundId)).toEqual({
      roundId: forced.roundId,
      crashPoint: 250,
      link: null, // nothing for the strip to send to the verifier (D13)
    });
  });

  it('faults break only the sender’s own connection', async () => {
    const server = await run(testConfig());
    const slow = await connect(server);
    const fine = await connect(server);
    await Promise.all([slow.login('slow'), fine.login('fine')]);

    slow.send({ type: 'devFaults', latencyMs: 300, dropRate: 0 });
    await sleep(50);
    const sent = Date.now();
    slow.send({ type: 'ping', clientTime: sent });
    fine.send({ type: 'ping', clientTime: sent });
    const fast = await fine.next('pong');
    const delayed = await slow.next('pong');
    expect(Date.now() - sent).toBeGreaterThanOrEqual(600); // 300 in, 300 out
    expect(delayed.serverTime - sent).toBeGreaterThanOrEqual(290); // stamped after the uplink delay
    expect(fast.serverTime - sent).toBeLessThan(200);

    slow.send({ type: 'devFaults', latencyMs: 0, dropRate: 1 });
    await sleep(400); // let the latency-delayed faults change land
    slow.send({ type: 'ping', clientTime: Date.now() });
    await expect(slow.next('pong', () => true, 500)).rejects.toThrow(/no pong/);

    const closed = new Promise<number>((resolve) => slow.socket.once('close', resolve));
    slow.send({ type: 'devDisconnect' });
    await closed;
    fine.send({ type: 'ping', clientTime: Date.now() });
    await fine.next('pong');
  });
});

describe('the wire, at the edges', () => {
  it('refuses moves before authenticate, answers malformed frames, drops unknown types, and rejects a stale token', async () => {
    const server = await run(testConfig());
    const client = await connect(server);
    client.send({ type: 'cashOut', betId: betId() });
    expect(await client.next('error')).toMatchObject({
      class: 'SESSION',
      code: 'NOT_AUTHENTICATED',
    });

    client.send({ type: 'chat', text: 'hello?' });
    client.send({ type: 'ping', clientTime: 1 });
    expect(await client.next('pong')).toMatchObject({ clientTime: 1 });
    expect(client.received.filter((m) => m.type === 'error')).toHaveLength(1); // chat: silence

    client.send({ type: 'authenticate', token: 'forged', nick: 'x' });
    expect(await client.next('error')).toMatchObject({ class: 'SESSION', code: 'SESSION_INVALID' });

    const hello = await client.login('ok');
    client.send({
      type: 'placeBet',
      betId: betId(),
      roundId: hello.round.roundId,
      amount: 0,
      autoCashOutAt: null,
    });
    expect(await client.next('error')).toMatchObject({
      class: 'PLAYER',
      code: 'MALFORMED_MESSAGE',
    });
    client.socket.send('{not json');
    client.send({ type: 'ping', clientTime: 2 });
    await client.next('pong', (m) => m.clientTime === 2);
  });

  it('keeps a betId single-use beyond the engine’s one-round memory (§7)', async () => {
    const server = await run(testConfig({ CRASH_GROWTH_RATE: '20', CRASH_BETTING_MS: '400' }));
    const ada = await connect(server);
    let round = (await ada.login('ada')).round;
    while (round.phase !== 'BETTING')
      round = { ...round, ...(await ada.next('bettingOpen')), phase: 'BETTING' };
    const reused = betId();
    ada.send({
      type: 'placeBet',
      betId: reused,
      roundId: round.roundId,
      amount: 100,
      autoCashOutAt: null,
    });
    await ada.next('betAccepted');
    await ada.next('bettingOpen');
    await ada.next('bettingOpen');
    const third = await ada.next('bettingOpen');
    ada.send({
      type: 'placeBet',
      betId: reused,
      roundId: third.roundId,
      amount: 100,
      autoCashOutAt: null,
    });
    expect(await ada.next('error')).toMatchObject({ code: 'DUPLICATE_BET_ID', betId: reused });
  }, 20_000);

  it('answers the probes, and never serves a seed that has not been revealed', async () => {
    const server = await run(testConfig({ CRASH_DEV_CHAIN_SEED: DEV_SEED }));
    expect(await getJson(`${server.url}/health`)).toEqual({ ok: true });
    expect(await getJson(`${server.url}/ready`)).toEqual({ ready: true });
    expect((await fetch(`${server.url}/fair/1/1`)).status).toBe(404); // round 1 is still open
    expect((await fetch(`${server.url}/fair/one/1`)).status).toBe(400);
    const listing = chainListing.parse(await getJson(`${server.url}/fair/chains`));
    expect(JSON.stringify(listing)).not.toContain(DEV_SEED);
  });
});
