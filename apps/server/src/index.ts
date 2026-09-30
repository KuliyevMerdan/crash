/**
 * @crash/server — Fastify + `ws`: the round loop, the broadcast, persistence (ROADMAP S3).
 *
 * `main.ts` is the process; `createServer` is everything else, so the tests build the very same
 * server on a random port.
 */
export { createServer, type Server } from './app.js';
export { readConfig, BootError, DEFAULT_GAME, type ServerConfig } from './config.js';
export { memoryStore } from './store/memory.js';
export { sqliteStore } from './store/sqlite.js';
export type { Store } from './store/store.js';
