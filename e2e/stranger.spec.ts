import { expect, test } from '@playwright/test';
import { errorsOf, placeBet, player } from './support.js';

/**
 * ROADMAP P1 "Done when": a stranger opens the link, plays a round, breaks the network from the
 * debug panel, watches it recover, and verifies the result they just got — in under two minutes.
 *
 * Nothing but the page: no dev hooks, no controller, no forced round. So it runs against the local
 * server in CI and, unchanged, against the live demo (`E2E_BASE_URL=… pnpm e2e:live`).
 */
test('a stranger plays, breaks their network, recovers and verifies the round', async ({
  browser,
}) => {
  const started = Date.now();
  const page = await player(browser);

  // Join whatever round is on; bet in the next betting window.
  await expect(page.locator('.action.place:enabled')).toBeVisible({ timeout: 90_000 });
  await placeBet(page, '1.00');

  // Break it: the network lab drops this socket, server-side, mid-betting.
  await page.locator('.lab summary').click();
  await page.getByRole('button', { name: 'Drop connection' }).click();
  await expect(page.locator('.lab-log')).toContainText('connection lost', { timeout: 10_000 });
  await expect(page.locator('.lab-log')).toContainText('back: a fresh hello restored the round', {
    timeout: 20_000,
  });
  await expect(page.locator('.bar .pill')).toHaveText('live');
  // The bet survived the drop — it was the server's all along.
  await expect(page.locator('.players-list .player.mine')).toBeVisible();

  // Ride it to the bust, then follow the banner to the proof.
  const link = page.locator('.result.lost a.verify-link');
  await expect(link).toBeVisible({ timeout: 120_000 });
  const crashedAt = (await page.locator('.result.lost').textContent())?.match(/\d+\.\d\d×/)?.[0];
  await link.click();
  await expect(page.locator('.verdict.verified')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.step.bad')).toHaveCount(0);
  if (crashedAt) await expect(page.locator('.report')).toContainText(crashedAt);

  const tookMs = Date.now() - started;
  expect(tookMs).toBeLessThan(120_000);
  expect(errorsOf(page)).toEqual([]);
  test.info().annotations.push({
    type: 'measured',
    description: `open → verified in ${(tookMs / 1000).toFixed(1)} s; the round crashed at ${crashedAt}`,
  });
});
