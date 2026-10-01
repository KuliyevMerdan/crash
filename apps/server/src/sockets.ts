import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Hub } from './hub.js';

export interface Sockets {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

/**
 * The `ws` transport for the hub: a socket is a `Peer`, its frames are the hub's to judge.
 *
 * **A heartbeat finds the sockets that died without saying so.** A client whose network vanished
 * sends no close frame, and TCP may not notice for many minutes — meanwhile the socket stays in
 * every broadcast. Every `heartbeatMs` each socket is sent a protocol-level ping (answered by the
 * browser itself, below any JavaScript); a socket that has not answered the previous one is
 * terminated. A dead peer is gone within two intervals.
 */
/** The close code the server ends a connection with — 4000s are the application's to define. */
export const CLOSED_BY_SERVER = 4000;

export function createSockets(hub: Hub, log: Logger, heartbeatMs: number): Sockets {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const answered = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (answered.get(ws) === false) {
        log.info('socket missed a heartbeat — terminated');
        ws.terminate();
        continue;
      }
      answered.set(ws, false);
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  wss.on('connection', (ws: WebSocket) => {
    answered.set(ws, true);
    ws.on('pong', () => answered.set(ws, true));
    const attached = hub.attach({
      send: (frame) => ws.send(frame),
      close: () => {
        ws.close(CLOSED_BY_SERVER, 'closed by the server');
        // A peer that never answers the close frame is gone; stop waiting for it.
        setTimeout(() => ws.terminate(), 2000).unref();
      },
      get isOpen() {
        return ws.readyState === ws.OPEN;
      },
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        log.warn('binary frame dropped');
        return;
      }
      attached.receive(rawText(data));
    });
    ws.on('close', () => attached.closed());
    ws.on('error', (error) => log.warn({ err: error }, 'socket error'));
  });

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    close() {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
