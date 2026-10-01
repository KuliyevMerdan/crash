import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { ChainBook } from './chains.js';
import type { ServerConfig } from './config.js';
import { Game } from './game.js';
import { registerRoutes } from './http.js';
import { createHub, type Hub } from './hub.js';
import { createSockets, type Sockets } from './sockets.js';
import type { Store } from './store/store.js';
import { systemClock, systemScheduler, type Clock, type Scheduler } from './time.js';

export interface GameServer {
  readonly game: Game;
  readonly hub: Hub;
  readonly chains: ChainBook;
  /** Start the round loop, delivering through the hub. */
  start(): void;
  stop(): void;
}

export interface GameServerDeps {
  config: ServerConfig;
  store: Store;
  log: Logger;
  clock?: Clock;
  scheduler?: Scheduler;
  random?: () => number;
}

/**
 * The server without its network: the loop, the chains and the connection hub. `createServer`
 * puts Fastify and `ws` in front of it; the root suite attaches in-process peers instead and runs
 * the real thing in virtual time.
 */
export function createGameServer(deps: GameServerDeps): GameServer {
  const { config, store, log } = deps;
  const clock = deps.clock ?? systemClock;
  const scheduler = deps.scheduler ?? systemScheduler;
  const chains = ChainBook.open(store, config.chain, config.game.houseEdgeBps, log);
  const game = Game.create({ config, store, chains, clock, scheduler, log });
  const hub = createHub({
    config,
    game,
    clock,
    scheduler,
    log,
    ...(deps.random ? { random: deps.random } : {}),
  });
  return {
    game,
    hub,
    chains,
    start: () => game.start(hub),
    stop() {
      game.stop();
      hub.close();
    },
  };
}

export interface Server extends GameServer {
  readonly app: FastifyInstance;
  readonly sockets: Sockets;
  /** Listens and starts the round loop; resolves with the bound address. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

/** Everything wired, nothing started — tests and `main.ts` both build the server through here. */
export function createServer(deps: GameServerDeps): Server {
  const { config, store, log } = deps;
  const core = createGameServer(deps);
  const app = Fastify<HttpServer, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: log,
    // The log is about rounds, keyed by roundId — not a line per HTTP probe.
    logController: new LogController({ disableRequestLogging: true }),
  });
  const sockets = createSockets(core.hub, log, config.heartbeatMs);
  registerRoutes(app, { config, store, chains: core.chains, game: core.game });

  app.server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head);
  });

  return {
    ...core,
    app,
    sockets,
    async listen() {
      const address = await app.listen({ host: config.host, port: config.port });
      core.start();
      log.info({ address, env: config.env, faults: config.faults }, 'listening');
      return address;
    },
    async close() {
      core.stop();
      sockets.close();
      await app.close();
      store.close();
    },
  };
}
