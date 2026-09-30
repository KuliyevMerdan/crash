import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Hub } from './hub.js';

export interface Sockets {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

/** The `ws` transport for the hub: a socket is a `Peer`, its frames are the hub's to judge. */
export function createSockets(hub: Hub, log: Logger): Sockets {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  wss.on('connection', (ws: WebSocket) => {
    const attached = hub.attach({
      send: (frame) => ws.send(frame),
      terminate: () => ws.terminate(),
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
      wss.close();
    },
  };
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
