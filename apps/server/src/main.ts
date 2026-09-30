import { pino } from 'pino';
import { createServer } from './app.js';
import { BootError, readConfig } from './config.js';
import { memoryStore } from './store/memory.js';
import { sqliteStore } from './store/sqlite.js';

try {
  const config = readConfig(process.env);
  const log = pino({ level: config.logLevel, base: { service: 'crash-server' } });
  const store = config.database === ':memory:' ? memoryStore() : sqliteStore(config.database);
  const server = createServer({ config, store, log });
  await server.listen();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    await server.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
} catch (error) {
  if (error instanceof BootError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  throw error;
}
