import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The web shell. In development Vite serves it and proxies the game's socket and `/fair/*` to
 * `apps/server` on :8080 (`pnpm dev` runs both); `__ASSERT_CURVE__` and the dev hooks are on in every build
 * but a production one (docs/protocol.md §9) — `--mode perf` is a minified build that keeps them, for
 * `scripts/perf.mjs`. `CRASH_SERVER` points the proxy elsewhere.
 */
const server = process.env['CRASH_SERVER'] ?? 'http://127.0.0.1:8080';
const proxy = {
  '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
  '/fair': server,
};

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __ASSERT_CURVE__: JSON.stringify(mode !== 'production'),
    __DEV_HOOKS__: JSON.stringify(mode !== 'production'),
  },
  server: { port: 5173, proxy },
  preview: { proxy },
  build: { target: 'es2022', sourcemap: true },
}));
