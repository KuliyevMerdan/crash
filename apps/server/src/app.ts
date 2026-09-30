import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { ChainBook } from './chains.js';
import type { ServerConfig } from './config.js';
import { Game } from './game.js';
import { registerRoutes } from './http.js';
import { createSockets, type Sockets } from './sockets.js';
import type { Store } from './store/store.js';
import { systemClock, systemScheduler, type Clock, type Scheduler } from './time.js';

export interface Server {
  readonly app: FastifyInstance;
  readonly game: Game;
  readonly sockets: Sockets;
  readonly chains: ChainBook;
  /** Listens and starts the round loop; resolves with the bound address. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

/** Everything wired, nothing started — tests and `main.ts` both build the server through here. */
export function createServer(deps: {
  config: ServerConfig;
  store: Store;
  log: Logger;
  clock?: Clock;
  scheduler?: Scheduler;
}): Server {
  const { config, store, log } = deps;
  const clock = deps.clock ?? systemClock;
  const scheduler = deps.scheduler ?? systemScheduler;

  const chains = ChainBook.open(store, config.chain, config.game.houseEdgeBps, log);
  const game = Game.create({ config, store, chains, clock, scheduler, log });
  const app = Fastify<HttpServer, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: log,
    // The log is about rounds, keyed by roundId — not a line per HTTP probe.
    logController: new LogController({ disableRequestLogging: true }),
  });
  const sockets = createSockets({ config, game, clock, scheduler, log });
  registerRoutes(app, { store, chains, game });

  app.server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head);
  });

  return {
    app,
    game,
    sockets,
    chains,
    async listen() {
      const address = await app.listen({ host: config.host, port: config.port });
      game.start(sockets);
      log.info({ address, env: config.env, faults: config.faults }, 'listening');
      return address;
    },
    async close() {
      game.stop();
      sockets.close();
      await app.close();
      store.close();
    },
  };
}
