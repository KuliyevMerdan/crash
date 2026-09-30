// ROADMAP C1 "Done when", measured: `pnpm perf:web`.
//
// A development server and the minified `--mode perf` build of the web app, two real Chromium
// pages — a phone (375×812, DPR 3, CPU throttled 4×) and a desktop — in one forced 100× round:
//
//   1. frame times on the throttled phone through the whole round;
//   2. a 5-second network stall on the phone's own socket mid-curve (devFaults, docs/protocol.md §9)
//      — the curve must keep drawing, never step backwards, never leap;
//   3. the two pages side by side — their clocks and their counters compared frame by frame.
//
// Needs Playwright's Chromium: set PLAYWRIGHT_BROWSERS_PATH if it is not in the default place.
import { chromium } from '@playwright/test';
import { curve, multiplierAt } from '@crash/curve';
import { startStack, until } from './stack.mjs';

const FORCED = 10_000; // 100.00×
const K = curve(0.15);
const quantile = (xs, q) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

const stack = await startStack({
  serverPort: 8091,
  webPort: 5191,
  serverEnv: { CRASH_BETTING_MS: '3000', CRASH_CRASHED_MS: '1500' },
});
const { control, heard } = stack;
const WEB = stack.webUrl;

// ── The browsers ──
const browser = await chromium.launch({ headless: true });
const phone = await browser.newContext({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const a = await phone.newPage();
const b = await desk.newPage();
const cdp = await phone.newCDPSession(a);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

for (const page of [a, b]) {
  await page.goto(WEB);
  await page.waitForFunction(() => window.__crash?.client.getState().status === 'live', null, {
    timeout: 20_000,
  });
  await page.evaluate(() => {
    const frames = [];
    const messages = [];
    window.__probe = { frames, messages, on: false };
    window.__crash.client.subscribe((_state, event) => {
      if (event.type === 'message')
        messages.push([performance.timeOrigin + performance.now(), event.message.type]);
      if (event.type === 'status' && event.status !== 'live')
        messages.push([performance.timeOrigin + performance.now(), `status:${event.status}`]);
    });
    const loop = () => {
      if (window.__probe.on) {
        const d = window.__crash.drawn();
        frames.push([
          performance.timeOrigin + performance.now(),
          d?.kind ?? null,
          d?.multiplier ?? null,
          window.__crash.client.serverNow(),
        ]);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

control.send(JSON.stringify({ type: 'devForceCrashPoint', crashPoint: FORCED }));
const opened = await until(
  () => heard.find((m) => m.type === 'bettingOpen' && m.chainIndex === null),
  60_000,
  'the forced round',
);
const heapBefore = await a.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
for (const page of [a, b]) await page.evaluate(() => (window.__probe.on = true));
const started = await until(
  () => heard.find((m) => m.type === 'roundStart' && m.roundId === opened.roundId),
  20_000,
  'the start',
);

// The stall, at ~12 s (≈6×): the phone's socket delays everything 5 s each way; the message that ends
// it is itself delayed 5 s on the way in, so nothing arrives for 5 s, then the backlog.
const STALL_AT = 12_000;
await until(() => Date.now() - started.startedAt >= STALL_AT, 30_000, 'the stall moment');
const stallStart = Date.now();
await a.evaluate(() => {
  window.__crash.sendRaw({ type: 'devFaults', latencyMs: 5000, dropRate: 0 });
  window.__crash.sendRaw({ type: 'devFaults', latencyMs: 0, dropRate: 0 });
});

const crash = await until(
  () => heard.find((m) => m.type === 'crash' && m.roundId === opened.roundId),
  60_000,
  'the crash',
);
await new Promise((r) => setTimeout(r, 12_000)); // let the phone's delayed backlog land
const heapAfter = await a.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
const [fa, fb] = await Promise.all([a, b].map((p) => p.evaluate(() => window.__probe.frames)));
const heardByPhone = await a.evaluate(() => window.__probe.messages);
await browser.close();
stack.stop();

// ── Analysis ──
const running = (frames) =>
  frames.filter((f) => f[1] === 'running' && f[3] >= started.startedAt && f[3] < crash.crashedAt);
const ra = running(fa);
const rb = running(fb);
const intervals = ra.slice(1).map((f, i) => f[0] - ra[i][0]);
const dropped = intervals.filter((d) => d > 25).length;

// The stall window, and the frames either side of it.
const windowFrames = fa.filter(
  (f) => f[0] >= stallStart - 1000 && f[0] <= stallStart + 11_000 && f[1] === 'running',
);
let backwards = 0;
let worstLeap = 0;
for (let i = 1; i < windowFrames.length; i += 1) {
  const [t0, , m0] = windowFrames[i - 1];
  const [t1, , m1] = windowFrames[i];
  if (m1 < m0) backwards += 1;
  // What the curve itself rose over that interval, plus a step of quantisation.
  const rise =
    multiplierAt(K, windowFrames[i][3] - started.startedAt) -
    multiplierAt(K, windowFrames[i][3] - (t1 - t0) - started.startedAt);
  worstLeap = Math.max(worstLeap, m1 - m0 - rise - 1);
}
const stallGap = Math.max(0, ...windowFrames.slice(1).map((f, i) => f[0] - windowFrames[i][0]));
// Proof the stall happened: the longest silence on the phone's socket around it.
const around = heardByPhone
  .map((m) => m[0])
  .filter((t) => t >= stallStart - 1000 && t <= stallStart + 11_000);

const silence = Math.max(0, ...around.slice(1).map((t, i) => t - around[i]));
// A healthy phone hears no error and never drops its socket — C1's first run did both, every 15 s,
// because its pings carried a fractional clientTime the server rejected.
const phoneErrors = heardByPhone.filter((m) => m[1] === 'error').length;
const phoneDrops = heardByPhone.filter((m) => m[1] === 'status:reconnecting').length;
const offsetA = ra.map((f) => f[3] - f[0]);
const offsetDrift = Math.max(...offsetA) - Math.min(...offsetA);

// Side by side: frames drawn within 2 ms of each other on the two pages.
let pairs = 0;
let clockGap = 0;
let counterGap = 0;
let j = 0;
for (const fA of ra) {
  while (j < rb.length - 1 && rb[j + 1][0] <= fA[0]) j += 1;
  for (const fB of [rb[j], rb[j + 1]]) {
    if (!fB || Math.abs(fB[0] - fA[0]) > 2) continue;
    pairs += 1;
    clockGap = Math.max(clockGap, Math.abs(fA[3] - fA[0] - (fB[3] - fB[0])));
    // Counters compared at one instant: each page's drawn value against the curve at its own clock.
    const mA = multiplierAt(K, fA[3] - started.startedAt);
    const mB = multiplierAt(K, fB[3] - started.startedAt + (fA[0] - fB[0]));
    counterGap = Math.max(counterGap, Math.abs(mA - mB));
  }
}

const ms = (x) => `${x.toFixed(1)} ms`;
const report = [
  `**C1 perf** · forced ${FORCED / 100}× round · phone: 375×812 @ DPR 3 (drawn at 2), CPU 4× throttled · headless Chromium`,
  '',
  '| Measure | Result |',
  '| --- | --- |',
  `| Phone frames through the round | ${ra.length} over ${((crash.crashedAt - started.startedAt) / 1000).toFixed(1)} s |`,
  `| Frame time p50 / p95 / max | ${ms(quantile(intervals, 0.5))} / ${ms(quantile(intervals, 0.95))} / ${ms(Math.max(...intervals))} |`,
  `| Frames over 25 ms | ${dropped} of ${intervals.length} (${((dropped / intervals.length) * 100).toFixed(2)}%) |`,
  `| Heap before → after the round | ${heapBefore === null ? 'n/a' : `${(heapBefore / 1e6).toFixed(1)} → ${(heapAfter / 1e6).toFixed(1)} MB`} |`,
  `| 5 s stall: longest silence on the phone's socket (proof it happened) | ${ms(silence)} |`,
  `| 5 s stall: longest gap between frames | ${ms(stallGap)} |`,
  `| 5 s stall: frames where the counter went backwards | ${backwards} |`,
  `| 5 s stall: worst leap beyond the curve's own rise | ${worstLeap} hundredths |`,
  `| Phone's clock estimate, drift across the round | ${ms(offsetDrift)} |`,
  `| Phone: errors heard / reconnects, whole run | ${phoneErrors} / ${phoneDrops} |`,
  `| Side by side: frame pairs within 2 ms | ${pairs} |`,
  `| Side by side: clock disagreement (max) | ${ms(clockGap)} |`,
  `| Side by side: counter disagreement at one instant (max) | ${counterGap} hundredths |`,
].join('\n');
console.log(report);

const failures = [];
if (quantile(intervals, 0.5) > 17.5) failures.push('median frame over 17.5 ms');
if (dropped / intervals.length > 0.02) failures.push('more than 2% of frames over 25 ms');
if (backwards > 0) failures.push('the counter went backwards during the stall');
if (worstLeap > 1) failures.push('the counter leapt during the stall');
if (stallGap > 100) failures.push('drawing paused during the stall');
if (silence < 4500) failures.push('the stall did not happen — the phone kept hearing the server');
if (phoneErrors > 0 || phoneDrops > 0)
  failures.push('the phone heard errors or dropped its socket');
if (clockGap > 20) failures.push('the two pages disagree on the server clock by over 20 ms');
if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join('; ')}`);
  process.exit(1);
}
