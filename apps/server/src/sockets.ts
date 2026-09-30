import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  decodeFrame,
  errorMessageOf,
  parseClientOrDevMessage,
  type DevMessageType,
  type ServerMessage,
} from '@crash/protocol';
import type { Logger } from 'pino';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { ServerConfig } from './config.js';
import type { Game, Outbox } from './game.js';
import type { Clock, Scheduler } from './time.js';

interface Connection {
  readonly ws: WebSocket;
  readonly id: number;
  playerId: string | null;
  /** `devFaults` (§9): this connection's own simulated network, and nobody else's. */
  faults: { latencyMs: number; dropRate: number };
}

export interface Sockets extends Outbox {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  readonly count: number;
  close(): void;
}

/**
 * The socket layer: frames in, effects out. It knows the wire and the connections; the rules are
 * the engine's and the timing is the game's.
 *
 * **`receivedAt` is the first thing that happens to a frame** — before it is decoded, parsed or
 * queued (ADR-0002). Server load after that point cannot become a payout difference.
 */
export function createSockets(deps: {
  config: ServerConfig;
  game: Game;
  clock: Clock;
  scheduler: Scheduler;
  log: Logger;
}): Sockets {
  const { config, game, clock, scheduler, log } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const connections = new Set<Connection>();
  const byPlayer = new Map<string, Set<Connection>>();
  let nextId = 1;

  const enabled: DevMessageType[] = [];
  if (config.env === 'development') enabled.push('devForceCrashPoint');
  if (config.faults) enabled.push('devFaults', 'devDisconnect');
  const parse = parseClientOrDevMessage(enabled);

  function transmit(conn: Connection, message: ServerMessage): void {
    const { latencyMs, dropRate } = conn.faults;
    if (dropRate > 0 && Math.random() < dropRate) return;
    const frame = JSON.stringify(message);
    const write = () => {
      if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(frame);
    };
    if (latencyMs > 0) scheduler.setTimeout(write, latencyMs);
    else write();
  }

  function bind(conn: Connection, playerId: string): void {
    conn.playerId = playerId;
    let set = byPlayer.get(playerId);
    if (set === undefined) byPlayer.set(playerId, (set = new Set()));
    set.add(conn);
  }

  function handle(conn: Connection, raw: string, receivedAt: number): void {
    const outcome = parse(decodeFrame(raw));
    if (outcome.kind === 'unknown-type') {
      log.warn({ conn: conn.id, type: outcome.type }, 'unknown message type dropped');
      return;
    }
    if (outcome.kind === 'malformed') {
      log.info({ conn: conn.id, type: outcome.type, issues: outcome.issues }, 'malformed message');
      transmit(
        conn,
        errorMessageOf('MALFORMED_MESSAGE', `${outcome.type}: ${outcome.issues.join('; ')}`),
      );
      return;
    }
    const message = outcome.message;
    switch (message.type) {
      case 'ping':
        transmit(conn, { type: 'pong', clientTime: message.clientTime, serverTime: receivedAt });
        return;
      case 'authenticate': {
        const session = game.authenticate(message.token, message.nick);
        if (session === null) {
          transmit(conn, errorMessageOf('SESSION_INVALID', 'unknown or expired token'));
          return;
        }
        if (conn.playerId !== null && conn.playerId !== session.playerId) {
          byPlayer.get(conn.playerId)?.delete(conn);
        }
        bind(conn, session.playerId);
        transmit(conn, game.hello(session.playerId, session.token));
        log.info({ conn: conn.id, playerId: session.playerId }, 'authenticated');
        return;
      }
      case 'devFaults':
        conn.faults = { latencyMs: message.latencyMs, dropRate: message.dropRate };
        log.info({ conn: conn.id, faults: conn.faults }, 'faults set on own connection');
        return;
      case 'devDisconnect':
        log.info({ conn: conn.id }, 'disconnect requested');
        conn.ws.terminate();
        return;
      case 'devForceCrashPoint':
        game.forceNext(message.crashPoint);
        return;
      case 'placeBet':
      case 'cancelBet':
      case 'cashOut':
        if (conn.playerId === null) {
          transmit(conn, errorMessageOf('NOT_AUTHENTICATED', 'authenticate first'));
          return;
        }
        game.submit(conn.playerId, message, receivedAt);
        return;
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      ws,
      id: nextId++,
      playerId: null,
      faults: { latencyMs: 0, dropRate: 0 },
    };
    connections.add(conn);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const arrive = () => {
        const receivedAt = clock.now(); // ← before anything else touches the frame
        if (isBinary) {
          log.warn({ conn: conn.id }, 'binary frame dropped');
          return;
        }
        try {
          handle(conn, rawText(data), receivedAt);
        } catch (error) {
          log.error({ conn: conn.id, err: error }, 'frame handling failed');
          transmit(conn, errorMessageOf('INTERNAL', 'the server could not process that'));
        }
      };
      // A simulated slow uplink delays the frame's *arrival*, so it is stamped after the delay —
      // network, not server load (docs/protocol.md §9).
      if (conn.faults.latencyMs > 0) scheduler.setTimeout(arrive, conn.faults.latencyMs);
      else arrive();
    });

    ws.on('close', () => {
      connections.delete(conn);
      if (conn.playerId !== null) byPlayer.get(conn.playerId)?.delete(conn);
    });
    ws.on('error', (error) => log.warn({ conn: conn.id, err: error }, 'socket error'));
  });

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    broadcast(message) {
      for (const conn of connections) if (conn.playerId !== null) transmit(conn, message);
    },
    send(playerId, message) {
      for (const conn of byPlayer.get(playerId) ?? []) transmit(conn, message);
    },
    get count() {
      return connections.size;
    },
    close() {
      for (const conn of connections) conn.ws.terminate();
      wss.close();
    },
  };
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
