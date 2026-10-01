// ROADMAP C2 "Done when", measured: `pnpm play:web`.
//
// Thirty rounds on a 300 ms connection (devFaults: 150 ms each way on the player's own socket,
// docs/protocol.md §9), played through the real panel in real Chromium: the bot types the stake,
// ticks auto cash-out on a third of the rounds, clicks Place bet, and on the others clicks CASH OUT
// at a random moment. For every manual cash-out it compares three numbers — what the curve showed at
// the press, what the button promised, what the server paid. "Never surprised" is the promise and
// the paid numbers being the same.
import { chromium } from '@playwright/test';
import { startStack, until } from './stack.mjs';

// At least 30 rounds, and on until there are 8 manual cash-outs to judge — how many a run gets
// depends on a chain drawn fresh each time (C3's re-run had 7). Never more than 60.
const ROUNDS = Number(process.env['ROUNDS'] ?? 30);
const MIN_MANUAL = 8;
const MAX_ROUNDS = 60;
const manualSoFar = () => rounds.filter((r) => r.report?.kind === 'manual').length;
const ONE_WAY = 150;
let seed = 20260930;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

const stack = await startStack({
  serverPort: 8092,
  webPort: 5192,
  serverEnv: { CRASH_BETTING_MS: '2500', CRASH_CRASHED_MS: '1200' },
});
const browser = await chromium.launch({ headless: true });
const page = await (
  await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
).newPage();
await page.goto(stack.webUrl);
await page.waitForFunction(() => window.__crash?.client.getState().status === 'live', null, {
  timeout: 20_000,
});
await page.evaluate(
  (ms) => window.__crash.sendRaw({ type: 'devFaults', latencyMs: ms, lossRate: 0 }),
  ONE_WAY,
);
// Let the clock re-learn the rtt (median of five samples, a ping every 5 s).
await page.waitForFunction(() => (window.__crash.client.getState().clock.rtt ?? 0) >= 280, null, {
  timeout: 60_000,
  polling: 250,
});

const phase = () => page.evaluate(() => window.__crash.client.getState().game?.round.phase);
const rounds = [];

for (let i = 0; i < MAX_ROUNDS && (i < ROUNDS || manualSoFar() < MIN_MANUAL); i += 1) {
  await until(async () => (await phase()) === 'CRASHED', 120_000, 'a crash'); // start each round clean
  await until(async () => (await phase()) === 'BETTING', 30_000, 'betting');
  await page.waitForTimeout(ONE_WAY + 50); // let the "betting open" frame settle into the panel

  const auto = random() < 1 / 3 ? 120 + Math.floor(random() * 180) : null;
  await page.locator('.stepper input').first().fill('5.00');
  const box = page.locator('input[type=checkbox]');
  if ((await box.isChecked()) !== (auto !== null)) await box.click();
  if (auto !== null)
    await page
      .locator('input[aria-label="Auto cash-out multiplier"]')
      .fill((auto / 100).toFixed(2));
  await page.locator('.action.place').click();
  const accepted = await page
    .waitForFunction(
      () => window.__crash.client.getState().game?.myBets[0]?.status === 'OPEN',
      null,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!accepted) {
    rounds.push({ kind: 'missed' }); // betting closed while the click travelled — counted, not hidden
    continue;
  }

  const reportsBefore = await page.evaluate(() => window.__crash.reports.length);
  if (auto === null) {
    const target = 110 + Math.floor(random() * 200);
    const reached = await page
      .waitForFunction(
        (t) => {
          const c = window.__crash.client;
          return c.getState().game?.round.phase === 'CRASHED' || (c.multiplier() ?? 0) >= t;
        },
        target,
        { timeout: 120_000, polling: 'raf' },
      )
      .then(() => phase());
    if (reached === 'RUNNING') {
      await page
        .locator('.action.cashout')
        .click({ timeout: 2000 })
        .catch(
          (e) => process.env['PLAY_DEBUG'] && console.log('click failed', String(e).slice(0, 300)),
        );
    }
  }
  await until(async () => (await phase()) === 'CRASHED', 120_000, 'the crash');
  await page.waitForTimeout(ONE_WAY * 2 + 100); // the delayed replies land
  const report = await page.evaluate((n) => window.__crash.reports.slice(n), reportsBefore);
  const crashPoint = await page.evaluate(() => {
    const r = window.__crash.client.getState().game?.round;
    return r?.phase === 'CRASHED' ? r.crashPoint : null;
  });
  rounds.push({
    kind: auto === null ? 'manual' : 'auto',
    auto,
    crashPoint,
    report: report[0] ?? null,
  });
}

await browser.close();
stack.stop();

if (process.env['PLAY_DEBUG']) console.log(JSON.stringify(rounds, null, 1));
// ── Analysis ──
const manual = rounds.filter((r) => r.report?.kind === 'manual').map((r) => r.report);
const autos = rounds.filter((r) => r.kind === 'auto' && r.report?.kind === 'auto');
const autoRounds = rounds.filter((r) => r.kind === 'auto');
const late = rounds.filter((r) => r.report?.kind === 'late');
const busted = rounds.filter((r) => r.kind === 'manual' && r.report === null);
const surprise = manual.map((m) => Math.abs(m.actual - m.press.predicted));
const onScreen = manual.map((m) => m.actual - m.press.screen);
const max = (xs) => (xs.length ? Math.max(...xs) : 0);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const autoWrong = autoRounds.filter(
  (r) =>
    r.auto <= r.crashPoint !== (r.report?.kind === 'auto') ||
    (r.report && r.report.actual !== r.auto),
);

const lines = [
  `**C2 play** · ${rounds.length} rounds · ${ONE_WAY * 2} ms round trip (devFaults) · real panel, real Chromium`,
  '',
  '| Measure | Result |',
  '| --- | --- |',
  `| Manual cash-outs paid | ${manual.length} |`,
  `| … paid minus the button's promise: mean / max | ${mean(surprise).toFixed(2)} / ${max(surprise)} hundredths |`,
  `| … paid minus what the curve showed at the press: mean / max | ${mean(onScreen).toFixed(2)} / ${max(onScreen)} hundredths |`,
  `| Manual presses that arrived after the crash (TOO_LATE) | ${late.length} |`,
  `| Rounds that crashed before the bot's target (busted, no press) | ${busted.length} |`,
  `| Auto cash-out rounds / paid exactly the target when it was reached | ${autoRounds.length} / ${autos.length} |`,
  `| Auto cash-outs off "wins iff target ≤ crash point, pays the target" | ${autoWrong.length} |`,
  `| Bets that missed betting (click landed after the close) | ${rounds.filter((r) => r.kind === 'missed').length} |`,
];
console.log(lines.join('\n'));

const failures = [];
if (manual.length < MIN_MANUAL) failures.push('too few manual cash-outs to judge');
if (max(surprise) > 2)
  failures.push('a cash-out paid more than two hundredths off the button’s promise');
if (autoWrong.length > 0) failures.push('an auto cash-out broke the rule');
if (failures.length) {
  console.error(`\nFAILED: ${failures.join('; ')}`);
  process.exit(1);
}
