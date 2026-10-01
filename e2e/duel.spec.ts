import { expect, test } from '@playwright/test';
import { Controller, errorsOf, placeBet, player, type Msg } from './support.js';

/**
 * ROADMAP P1: two browser contexts in one round — one cashing out, one busting — both drawing the
 * same multiplier at the same moment. The round is forced to 3.00× (about 7.3 s of climb), so the
 * test knows the ending and can hold both screens to it.
 */
const FORCED = 300;

test.skip(Boolean(process.env['E2E_BASE_URL']), 'forcing a round needs a development server');

test('two players in one round: one cashes out, one busts, both on the same curve', async ({
  browser,
  baseURL,
}) => {
  const control = await Controller.connect(baseURL ?? '');
  const [ada, bo] = await Promise.all([player(browser), player(browser)]);

  // Every frame each page draws while the round runs, stamped with the wall clock both share.
  for (const page of [ada, bo]) {
    await page.evaluate(() => {
      window.__frames = [];
      const loop = () => {
        const drawn = window.__crash?.drawn();
        if (drawn?.kind === 'running') {
          window.__frames?.push([performance.timeOrigin + performance.now(), drawn.multiplier]);
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
  }

  control.send({ type: 'devForceCrashPoint', crashPoint: FORCED });
  const opened = await control.next(
    (m): m is Msg<'bettingOpen'> => m.type === 'bettingOpen' && m.chainIndex === null,
  );
  for (const page of [ada, bo]) {
    await page.waitForFunction((roundId) => {
      const round = window.__crash?.client.getState().game?.round;
      return round?.roundId === roundId && round.phase === 'BETTING';
    }, opened.roundId);
    // Only this round's frames: the one before it may well have climbed past 3.00×.
    await page.evaluate(() => void (window.__frames = []));
  }

  await Promise.all([placeBet(ada, '5.00'), placeBet(bo, '5.00')]);
  // Each sees the other's stake on the table.
  await expect(ada.locator('.players-list .player')).toHaveCount(2);
  await expect(bo.locator('.players-list .player')).toHaveCount(2);

  // Ada presses once the curve is past 1.50×; Bo rides it to the bust.
  const cashout = ada.locator('.action.cashout');
  await expect(cashout).toBeEnabled({ timeout: 15_000 });
  await ada.waitForFunction(() => (window.__crash?.client.multiplier() ?? 0) >= 150);
  await cashout.click();
  await expect(ada.locator('.result.won')).toBeVisible();

  const crash = await control.next(
    (m): m is Msg<'crash'> => m.type === 'crash' && m.roundId === opened.roundId,
  );
  expect(crash.crashPoint).toBe(FORCED);

  // Ada was paid what her button promised; Bo lost the stake; each screen says so.
  const report = await ada.evaluate(() => window.__crash?.reports.at(-1));
  if (report?.kind !== 'manual') throw new Error(`no manual cash-out report: ${report?.kind}`);
  expect(Math.abs(report.actual - report.press.predicted)).toBeLessThanOrEqual(1);
  expect(report.actual).toBeLessThan(FORCED);
  const got = `${(report.actual / 100).toFixed(2)}×`;
  await expect(ada.locator('.result.won')).toContainText(`cashed out at ${got}`);
  await expect(bo.locator('.result.lost')).toContainText('crashed at 3.00×');
  const [adaBet, boBet] = await Promise.all(
    [ada, bo].map((p) => p.evaluate(() => window.__crash?.client.getState().game?.myBets[0])),
  );
  expect(crash.settled).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ betId: adaBet?.betId, won: true }),
      expect.objectContaining({ betId: boBet?.betId, won: false }),
    ]),
  );
  expect(adaBet?.status).toBe('CASHED_OUT');
  expect(boBet?.status).toBe('LOST');

  // The table is one table: Bo's screen shows Ada's cash-out, and both strips end on the same
  // round — dashed, because a forced round has nothing to verify.
  await expect(bo.locator('.players-list .player.cashed')).toContainText(got);
  for (const page of [ada, bo]) {
    await expect(page.locator('.history li').first()).toHaveText('3.00×');
    await expect(page.locator('.history li .chip').first()).toHaveClass(/forced/);
  }

  // The same moment, the same number: pair the frames the two pages drew within half a frame of
  // each other. Over 8 ms the curve rises at most 0.36 hundredths below 3.00×, so "within one
  // hundredth" still means the two screens agree, not that the window hid a gap. (2 ms pairs, as
  // perf:web uses, depend on how two pages' frames happen to align: 134 to 879 of them per run.)
  const frames = (p: typeof ada) => p.evaluate(() => window.__frames ?? []);
  const [fa, fb] = await Promise.all([frames(ada), frames(bo)]);
  let pairs = 0;
  let worst = 0;
  let j = 0;
  for (const [t, m] of fa) {
    while (j < fb.length - 1 && (fb[j + 1]?.[0] ?? Infinity) <= t) j += 1;
    const near = [fb[j], fb[j + 1]].find((f) => f !== undefined && Math.abs(f[0] - t) <= 8);
    if (near === undefined || m === null || near[1] === null) continue;
    pairs += 1;
    worst = Math.max(worst, Math.abs(m - near[1]));
  }
  expect(pairs).toBeGreaterThan(200);
  expect(worst).toBeLessThanOrEqual(1); // hundredths
  expect(Math.max(...fa.map((f) => f[1] ?? 0), ...fb.map((f) => f[1] ?? 0))).toBeLessThanOrEqual(
    FORCED,
  );

  expect(errorsOf(ada)).toEqual([]);
  expect(errorsOf(bo)).toEqual([]);
  test.info().annotations.push({
    type: 'measured',
    description: `${pairs} frame pairs within 8 ms, worst disagreement ${worst} hundredths; Ada paid at ${got}`,
  });
  control.close();
});
