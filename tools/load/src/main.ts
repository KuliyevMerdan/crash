import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { Clock, Scheduler } from '@crash/client-core';
import { historyEntry, myBet, roundSnapshot } from '@crash/protocol';
import WebSocket from 'ws';
import { z } from 'zod';
import { Population, type Bot, type Link, type Profile, type Truth } from './population.js';
import { formatSummary, summarize, type Summary } from './stats.js';

/**
 * `pnpm load -- --clients 500 --minutes 30` — ROADMAP P0 over real sockets, in real time.
 *
 * A development server is started as its own process on a fresh SQLite file (every bet a real
 * `synchronous = FULL` transaction), and a crowd of real `client-core` players joins it over `ws`.
 * First a handful of players alone, to measure the quiet server; then the crowd, with the fault
 * schedule of `tests/soak.test.ts` and a reconnect storm every five minutes; then the faults stop,
 * the crowd settles, and every player is held to the server's own account (`GET /dev/audit`).
 */
const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
};
const CLIENTS = arg('clients', 500);
const MINUTES = arg('minutes', 30);
const PORT = arg('port', 8095);
const STORM_EVERY_MS = arg('storm-every', 300) * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const base = `http://127.0.0.1:${PORT}`;
const clock: Clock = { now: () => performance.timeOrigin + performance.now() };
const scheduler: Scheduler = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let seed = 20261001;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

/** A `ws` socket as a client-core transport — one that can also go dark without closing. */
function wsLink(url: string): Link {
  let current: { dark: boolean; socket: WebSocket } | null = null;
  return {
    connect(handlers) {
      // Protocol pings are answered by hand, so a dark link stops answering the server's
      // heartbeat too — as a vanished network would.
      const socket = new WebSocket(url, { autoPong: false });
      const link = { dark: false, socket };
      current = link;
      socket.on('open', () => handlers.open());
      socket.on('message', (data: WebSocket.RawData) => {
        if (!link.dark) handlers.message(data.toString());
      });
      socket.on('ping', (data: Buffer) => {
        if (!link.dark) socket.pong(data);
      });
      socket.on('close', () => handlers.close());
      socket.on('error', () => {}); // a close always follows
      return {
        send: (frame) => {
          if (!link.dark && socket.readyState === WebSocket.OPEN) socket.send(frame);
        },
        close: () => socket.terminate(),
      };
    },
    blackhole() {
      if (current) current.dark = true;
    },
  };
}

const auditSchema = z.object({
  money: z.object({ granted: z.number(), accounted: z.number(), house: z.number() }),
  round: roundSnapshot,
  history: z.array(historyEntry),
  players: z.array(z.object({ id: z.string(), balance: z.number(), myBets: z.array(myBet) })),
});

async function audit(): Promise<Truth> {
  const body = auditSchema.parse(await (await fetch(`${base}/dev/audit`)).json());
  return {
    money: body.money,
    round: body.round,
    history: body.history,
    players: new Map(body.players.map((p) => [p.id, { balance: p.balance, myBets: p.myBets }])),
  };
}

async function until<T>(what: string, ms: number, fn: () => T | Promise<T>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function startServer(): { child: ChildProcess; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'crash-load-'));
  const child = spawn(process.execPath, [path.join(root, 'apps/server/dist/main.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CRASH_ENV: 'development',
      CRASH_DB: path.join(dir, 'load.db'),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return { child, dir };
}

const lines: string[] = [];
const failures: string[] = [];
const row = (measure: string, value: string, ok = true) => {
  lines.push(`| ${measure} | ${value} |`);
  if (!ok) failures.push(measure);
};
const samplesOf = (pop: Population, kind: string, profile: Profile, label: string) =>
  pop.samples.get(`${kind}:${profile}:${label}`) ?? [];

const { child, dir } = startServer();
const stopServer = () => {
  child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
};
process.on('exit', () => child.kill('SIGTERM'));

try {
  await until('the server', 30_000, () =>
    fetch(`${base}/ready`)
      .then((r) => r.ok)
      .catch(() => false),
  );

  // ── 1. The quiet server: five players, alone, twenty seconds ──
  const quiet = new Population({
    size: 5,
    link: () => wsLink(`ws://127.0.0.1:${PORT}/ws`),
    clock,
    scheduler,
    random,
    far: 0,
    lossy: 0,
    skewed: 0,
  });
  quiet.label = 'idle';
  quiet.start();
  await sleep(20_000);
  quiet.stop();
  const idleStamp = summarize(samplesOf(quiet, 'stamp', 'clean', 'idle'));
  const idleFanout = summarize(samplesOf(quiet, 'fanout', 'clean', 'idle'));

  // ── 2. The crowd ──
  const crowd = new Population({
    size: CLIENTS,
    link: () => wsLink(`ws://127.0.0.1:${PORT}/ws`),
    clock,
    scheduler,
    random,
    arrivalMs: 10_000,
  });
  crowd.tickSampleEvery = Math.max(1, Math.ceil(CLIENTS / 40)); // ~40 players sample every tick
  crowd.start();
  await until('the crowd', 60_000, () =>
    crowd.bots.every((b) => b.client.getState().status === 'live'),
  );

  const breaches: string[] = [];
  let audits = 0;
  const auditor = setInterval(() => {
    void audit()
      .then((t) => {
        audits += 1;
        if (t.money.granted !== t.money.accounted)
          breaches.push(`granted ${t.money.granted}, accounted ${t.money.accounted}`);
      })
      .catch(() => {});
  }, 30_000);
  const stalls = setInterval(() => crowd.stall(crowd.pick(0.03), 3000), 20_000);
  const darks = setInterval(() => crowd.blackhole(crowd.pick(0.01)), 45_000);

  const recoveries: number[] = [];
  const storm = async () => {
    await until('a running round', 60_000, async () => (await audit()).round.phase === 'RUNNING');
    const victims: Bot[] = crowd.pick(0.4);
    const at = Date.now();
    crowd.label = 'storm';
    crowd.storm(victims);
    await sleep(500);
    await until('the storm to pass', 60_000, () =>
      victims.every((b) => b.client.getState().status === 'live'),
    );
    recoveries.push(Date.now() - at);
    await sleep(Math.max(0, 10_000 - (Date.now() - at)));
    crowd.label = 'steady';
  };

  const endAt = Date.now() + MINUTES * 60_000;
  let nextStorm = Date.now() + Math.min(STORM_EVERY_MS, 120_000);
  while (Date.now() < endAt) {
    if (Date.now() >= nextStorm) {
      await storm();
      nextStorm = Date.now() + STORM_EVERY_MS;
      process.stderr.write(`[load] storm ${recoveries.length}: back in ${recoveries.at(-1)} ms\n`);
    }
    await sleep(1000);
  }

  // ── 3. Settle, and hold every player to the server's account ──
  clearInterval(stalls);
  clearInterval(darks);
  clearInterval(auditor);
  crowd.quiesce();
  await sleep(30_000);
  await until('a quiet round', 120_000, async () => (await audit()).round.phase === 'BETTING');
  await sleep(1500);
  const truth = await audit();
  const wrong = crowd.compare(truth);
  crowd.stop();

  // ── Report ──
  const all = Object.values(crowd.tally);
  const sum = (f: (t: (typeof all)[number]) => number) => all.reduce((a, t) => a + f(t), 0);
  const stampSteady = summarize(samplesOf(crowd, 'stamp', 'clean', 'steady'));
  const stampStorm = summarize(samplesOf(crowd, 'stamp', 'clean', 'storm'));
  const fanSteady = summarize(samplesOf(crowd, 'fanout', 'clean', 'steady'));
  const fanStorm = summarize(samplesOf(crowd, 'fanout', 'clean', 'storm'));
  const window = (p: Profile) => summarize(samplesOf(crowd, 'window', p, 'steady'));
  const fmt = (s: Summary) => formatSummary(s);

  lines.unshift(
    `**P0 load** · ${CLIENTS} players · ${MINUTES} min · real sockets, server process on SQLite`,
    '',
    '| Measure | Result |',
    '| --- | --- |',
  );
  row(
    'Money: granted = accounted, audits every 30 s',
    `${audits} audits, ${breaches.length} breaches`,
    breaches.length === 0 && truth.money.granted === truth.money.accounted,
  );
  row('Players in a wrong state at the end', `${wrong.length} of ${CLIENTS}`, wrong.length === 0);
  row(
    'Bets accepted / manual cash-outs / auto cash-outs / cancels',
    `${sum((t) => t.accepted)} / ${sum((t) => t.manual)} / ${sum((t) => t.auto)} / ${sum((t) => t.cancelled)}`,
  );
  row(
    'Reconnects / resyncs, whole crowd',
    `${sum((t) => t.reconnects)} / ${sum((t) => t.resyncs)}`,
  );
  row('`receivedAt` stamp, clean link: quiet server (p50 / p99 / max)', fmt(idleStamp));
  row(`… under ${CLIENTS} players`, fmt(stampSteady), stampSteady.p99 - idleStamp.p99 < 10);
  row('… during a reconnect storm', fmt(stampStorm));
  row('Tick fan-out, clean link: quiet server', fmt(idleFanout));
  row(`… under ${CLIENTS} players`, fmt(fanSteady));
  row('… during a reconnect storm', fmt(fanStorm));
  row(
    `Reconnect storms (40% of the crowd, mid-round): back live in`,
    recoveries.map((r) => `${(r / 1000).toFixed(1)} s`).join(', ') || '—',
    recoveries.every((r) => r < 15_000),
  );
  for (const p of ['clean', 'far', 'lossy'] as const) {
    const t = crowd.tally[p];
    row(`Betting window left when bettingOpen lands — ${p}`, fmt(window(p)));
    row(
      `… bets refused BETTING_CLOSED / TOO_LATE — ${p}`,
      `${t.missedBetting} of ${t.bets} / ${t.tooLate}`,
    );
  }
  console.log(lines.join('\n'));
  if (wrong.length > 0) {
    console.error(`\nWrong states:\n  ${wrong.slice(0, 20).join('\n  ')}`);
    for (const line of wrong.slice(0, 3)) {
      const bot = crowd.bots.find((b) => line.startsWith(`${b.nick} `));
      if (bot) console.error(`\nTrace of ${bot.nick}:\n  ${crowd.traceOf(bot).join('\n  ')}`);
    }
  }
  console.error(
    `\nResync causes: ${JSON.stringify(Object.fromEntries(all.map((t, i) => [i, t.resyncCauses])))}`,
  );
  if (breaches.length > 0) console.error(`\nMoney breaches:\n  ${breaches.join('\n  ')}`);
} finally {
  stopServer();
}
if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join('; ')}`);
  process.exit(1);
}
process.exit(0);
