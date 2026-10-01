// ROADMAP C3 "Done when", measured: `pnpm verify:web`.
//
// A stranger — a fresh browser context, no token, no history — opens the game, bets through the
// real panel, never cashes out, loses, and follows the banner's link to the verification page. The
// page must verify the round in the browser, every step, against the commit this browser was handed
// before it bet. Then the same page is pointed at servers that lie (Playwright rewrites the /fair
// replies) and must say so, and at the far end of a million-link chain, where it must finish the
// walk without freezing the page.
import { createChain, crashPoint } from '@crash/fair';
import { chromium } from '@playwright/test';
import { startStack, until } from './stack.mjs';

const stack = await startStack({
  serverPort: 8093,
  webPort: 5193,
  serverEnv: { CRASH_BETTING_MS: '2500', CRASH_CRASHED_MS: '4000' },
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let expected404 = 0;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // The browser logs the deliberate request for an unrevealed round (§3.3: 404, never the seed).
  if (/\b404\b/.test(m.text()) && /\/fair\/\d+\/999999$/.test(m.location().url)) expected404 += 1;
  else errors.push(m.text());
});

const results = [];
const failures = [];
const record = (measure, value, ok = true) => {
  results.push([measure, value]);
  if (!ok) failures.push(measure);
};
const steps = () =>
  page.$$eval('.step', (els) =>
    els.map((el) =>
      el.classList.contains('ok') ? 'ok' : el.classList.contains('bad') ? 'bad' : '-',
    ),
  );
const verdict = async () => {
  await page.waitForSelector('.verdict.verified, .verdict.failed', { timeout: 30_000 });
  return page.$eval('.verdict', (el) =>
    el.classList.contains('verified') ? 'verified' : 'failed',
  );
};

// ── 1. Play a round and lose it, through the real panel ──
await page.goto(stack.webUrl);
await page.waitForFunction(() => window.__crash?.client.getState().status === 'live', null, {
  timeout: 20_000,
});
const phase = () => page.evaluate(() => window.__crash.client.getState().game?.round.phase);
await until(async () => (await phase()) === 'CRASHED', 120_000, 'a crash');
await until(async () => (await phase()) === 'BETTING', 30_000, 'betting');
await page.waitForTimeout(150);
await page.locator('.stepper input').first().fill('5.00');
await page.locator('.action.place').click();
await page.waitForFunction(
  () => window.__crash.client.getState().game?.myBets[0]?.status === 'OPEN',
);
await until(async () => (await phase()) === 'CRASHED', 120_000, 'the crash');
const lost = await page.evaluate(() => {
  const g = window.__crash.client.getState().game;
  return { status: g.myBets[0]?.status, crashPoint: g.round.crashPoint, fair: g.round.fair };
});
record(
  'The stranger’s bet',
  `${lost.status} at ${(lost.crashPoint / 100).toFixed(2)}×`,
  lost.status === 'LOST',
);

// ── 2. Follow the banner to the verifier ──
const started = Date.now();
await page.locator('.result a.verify-link').click();
const honest = await verdict();
const tookMs = Date.now() - started;
const honestSteps = await steps();
record(
  `Round ${lost.fair?.chainIndex} from the banner: verdict / steps`,
  `${honest} / ${honestSteps.join(' ')}`,
  honest === 'verified' && honestSteps.slice(1).every((s) => s === 'ok'), // step 1 is the claim
);
record('… click to verdict', `${tookMs} ms`);
const shown = await page.$eval('.report', (el) => el.textContent ?? '');
record(
  '… shows the seed, the HMAC and the crash point it recomputed',
  shown.includes(lost.fair.seed) && shown.includes(`${(lost.crashPoint / 100).toFixed(2)}×`)
    ? 'yes'
    : 'no',
  shown.includes(lost.fair.seed),
);

// The same round from the history strip, as a stranger browsing back would pick it.
await page.goto(stack.webUrl);
await page.waitForSelector('.history a.chip');
await page.locator('.history a.chip').first().click();
await page.waitForURL(/#\/verify\/\d+\/\d+$/);
const fromStrip = await verdict();
record('The newest round from the history strip', fromStrip, fromStrip === 'verified');

// ── 3. Servers that lie — the page must catch them, not believe them ──
const { chainIndex, chainId } = lost.fair;
const revealUrl = `**/fair/${chainId}/${chainIndex}`;
const real = await (await fetch(`${stack.webUrl}fair/${chainId}/${chainIndex}`)).json();
const lies = [
  ['a crash point the seed does not produce', { ...real, crashPoint: real.crashPoint + 1 }],
  ['a forged seed', { ...real, seed: 'ab'.repeat(32) }],
  ['the previous round’s seed passed off as this one', { ...real, seed: real.previousHash }],
];
for (const [name, body] of lies) {
  await page.route(revealUrl, (route) => route.fulfill({ json: body }));
  await page.goto(`${stack.webUrl}#/verify/${chainId}/${chainIndex}`);
  await page.reload();
  const v = await verdict();
  record(`A server that sends ${name}`, `${v} / ${(await steps()).join(' ')}`, v === 'failed');
  await page.unroute(revealUrl);
}

// A commit swapped after this browser joined: the chain list now names another commit.
await page.route('**/fair/chains', async (route) => {
  const listing = await (await route.fetch()).json();
  listing.chains = listing.chains.map((c) =>
    c.id === chainId ? { ...c, commit: 'cd'.repeat(32) } : c,
  );
  await route.fulfill({ json: listing });
});
await page.goto(`${stack.webUrl}#/verify/${chainId}/${chainIndex}`);
await page.reload();
const swapped = await verdict();
record('A server that swapped the commit after the browser joined', swapped, swapped === 'failed');
await page.unroute('**/fair/chains');

// An index not yet played: the page says so, and the server never yields a seed for it.
await page.goto(`${stack.webUrl}#/verify/${chainId}/999999`);
await page.reload();
await page.waitForSelector('.verdict.failed');
const unrevealed = await page.$eval('.verdict', (el) => el.textContent ?? '');
record(
  'A round not yet revealed',
  `refused, no seed (${expected404} × 404)`,
  /not been revealed/.test(unrevealed) && expected404 >= 1,
);

// ── 4. The far end of a million-link chain, walked in this tab ──
const t0 = Date.now();
const LENGTH = 1_000_000;
const SALT = 'crash-demo-chain-2';
const deep = createChain('5a'.repeat(32), LENGTH);
const far = LENGTH - 1;
const farSeed = deep.seedAt(far);
const chainBuildMs = Date.now() - t0;
await page.route('**/fair/chains', async (route) => {
  const listing = await (await route.fetch()).json();
  listing.chains.push({
    id: 2,
    commit: deep.commit,
    salt: SALT,
    length: LENGTH,
    houseEdgeBps: 100,
  });
  await route.fulfill({ json: listing });
});
await page.route(`**/fair/2/${far}`, (route) =>
  route.fulfill({
    json: {
      chainId: 2,
      chainIndex: far,
      seed: farSeed,
      previousHash: deep.seedAt(far - 1),
      crashPoint: crashPoint(farSeed, SALT, 100),
      roundId: '01J8ZQ3X0000000000000000AA',
    },
  }),
);
await page.goto(`${stack.webUrl}#/verify/2/${far}`);
await page.reload();
// Sample the frame gaps while the walk runs: the page must keep drawing.
await page.evaluate(() => {
  window.__gaps = [];
  let last = performance.now();
  const loop = (t) => {
    window.__gaps.push(t - last);
    last = t;
    if (!window.document.querySelector('.verdict.verified, .verdict.failed'))
      requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
const walkStart = Date.now();
const deepVerdict = await verdict();
const walkMs = Date.now() - walkStart;
const gaps = await page.evaluate(() => window.__gaps.slice(1));
const worstGap = Math.max(...gaps);
record(
  `Chain index ${far.toLocaleString('en')} (a 1,000,000-link chain)`,
  deepVerdict,
  deepVerdict === 'verified',
);
record('… the walk: hashes / time in the page', `${far.toLocaleString('en')} / ${walkMs} ms`);
record(
  '… longest gap between frames during the walk',
  `${worstGap.toFixed(1)} ms over ${gaps.length} frames`,
  worstGap < 100,
);
await page.unrouteAll();

await browser.close();
stack.stop();
record('Page errors, whole run', String(errors.length), errors.length === 0);

console.log(
  [
    '**C3 verify** · a stranger’s lost round, verified in headless Chromium (390×844, mobile)',
    '',
    '| Measure | Result |',
    '| --- | --- |',
    ...results.map(([m, v]) => `| ${m} | ${v} |`),
  ].join('\n'),
);
if (process.env['VERIFY_DEBUG']) console.log({ chainBuildMs, errors });
if (failures.length) {
  console.error(`\nFAILED: ${failures.join('; ')}`);
  process.exit(1);
}
