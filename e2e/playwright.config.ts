import { defineConfig, devices } from '@playwright/test';

/**
 * The E2E suite (ROADMAP P1). Two ways to run it:
 *
 * - **Against a local server** (`pnpm e2e`, and CI): `apps/server` in development — so a round can
 *   be forced — serving the `--mode perf` build of the web app from its own origin, exactly the
 *   one-origin shape the deploy has (ADR-0003). Both specs run.
 * - **Against any deployed copy** (`E2E_BASE_URL=https://… pnpm e2e:live`): no server is started,
 *   and only the stranger spec runs — it touches nothing but the page, as a visitor would. A
 *   production server forces nothing and its bundle has no dev hooks, so the duel cannot.
 */
const live = process.env['E2E_BASE_URL'];
const PORT = 8095;

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
  outputDir: '../test-results',
  use: {
    baseURL: live ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(live
    ? {}
    : {
        webServer: {
          command: 'node apps/server/dist/main.js',
          cwd: '..',
          url: `http://127.0.0.1:${PORT}/ready`,
          timeout: 30_000,
          reuseExistingServer: false,
          env: {
            CRASH_ENV: 'development',
            HOST: '127.0.0.1',
            PORT: String(PORT),
            CRASH_STATIC_DIR: 'apps/web/dist-perf',
            CRASH_BETTING_MS: '4000',
            CRASH_CRASHED_MS: '2500',
            CRASH_CHAIN_LENGTH: '10000',
            CRASH_CHAIN_ROTATE_AT: '1000',
            LOG_LEVEL: 'warn',
          },
        },
      }),
});
