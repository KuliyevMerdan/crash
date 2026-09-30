import { createHash } from 'node:crypto';
import { createChain, crashPoint } from '@crash/fair';
import { parseServerMessage, type ServerMessage } from '@crash/protocol';
import { pino, type Logger } from 'pino';
import WebSocket from 'ws';
import { createServer, type Server } from '../app.js';
import { readConfig, type ServerConfig } from '../config.js';
import { memoryStore } from '../store/memory.js';
import type { Store } from '../store/store.js';

export const CHAIN_LENGTH = 200;

/**
 * A development chain seed whose first link crashes at `minFirst` or above, so an integration test
 * has a round long enough to cash out in — found, not hardcoded, so it stays true if the formula
 * or the salt ever changes (and the golden test would say so first).
 */
export function devSeedWithFirstCrashAtLeast(
  minFirst: number,
  salt = 'crash-demo-chain-1',
): string {
  for (let i = 0; ; i += 1) {
    const seed = createHash('sha256').update(`crash-test-seed-${i}`).digest('hex');
    const chain = createChain(seed, CHAIN_LENGTH, { checkpointEvery: 50 });
    const first = crashPoint(chain.seedAt(1), salt, 100);
    if (first >= minFirst && first <= minFirst * 3) return seed;
  }
}

export function testConfig(env: Record<string, string> = {}): ServerConfig {
  return readConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    CRASH_CHAIN_LENGTH: String(CHAIN_LENGTH),
    CRASH_CHAIN_ROTATE_AT: '20',
    CRASH_BETTING_MS: '300',
    CRASH_CRASHED_MS: '100',
    CRASH_GROWTH_RATE: '1',
    ...env,
  });
}

export interface Running {
  readonly server: Server;
  readonly url: string;
  readonly ws: string;
  readonly lines: string[];
  close(): Promise<void>;
}

/** A real server — Fastify, `ws`, the loop, the store — on a random port. */
export async function start(config: ServerConfig, store: Store = memoryStore()): Promise<Running> {
  const lines: string[] = [];
  const log: Logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
  const server = createServer({ config, store, log });
  const url = await server.listen();
  return { server, url, ws: `${url.replace('http', 'ws')}/ws`, lines, close: () => server.close() };
}

/** A player on the wire: every frame parsed with the client's own schema, as a real client would. */
export class Client {
  readonly received: ServerMessage[] = [];
  /** Indices already handed out by `next` — each message is taken once, whatever order they came in. */
  private readonly taken = new Set<number>();
  private waiters: Array<{
    match: (m: ServerMessage) => boolean;
    resolve: (index: number) => void;
  }> = [];

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const outcome = parseServerMessage(JSON.parse(data.toString()));
      if (outcome.kind !== 'ok') throw new Error(`server sent ${outcome.kind}: ${data.toString()}`);
      const index = this.received.push(outcome.message) - 1;
      const waiter = this.waiters.find((w) => w.match(outcome.message));
      if (waiter !== undefined) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        this.taken.add(index);
        waiter.resolve(index);
      }
    });
  }

  static async connect(url: string): Promise<Client> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new Client(socket);
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  /** The earliest not-yet-taken message of `type` matching `where` — already here, or within `ms`. */
  async next<T extends ServerMessage['type']>(
    type: T,
    where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ms = 10_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const is = (m: ServerMessage): m is Extract<ServerMessage, { type: T }> =>
      isType(m, type) && where(m);
    const at = (index: number): Extract<ServerMessage, { type: T }> => {
      const m = this.received[index];
      if (m === undefined || !is(m)) throw new Error('harness: index does not hold the message');
      return m;
    };
    for (let i = 0; i < this.received.length; i += 1) {
      const m = this.received[i];
      if (!this.taken.has(i) && m !== undefined && is(m)) {
        this.taken.add(i);
        return at(i);
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        match: is,
        resolve: (index: number) => {
          clearTimeout(timer);
          resolve(at(index));
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`no ${type} within ${ms} ms`));
      }, ms);
      this.waiters.push(waiter);
    });
  }

  /** Authenticate and return the `hello`. */
  async login(
    nick: string,
    token: string | null = null,
  ): Promise<Extract<ServerMessage, { type: 'hello' }>> {
    this.send({ type: 'authenticate', token, nick });
    return this.next('hello');
  }

  types(): string[] {
    return this.received.filter((m) => m.type !== 'tick').map((m) => m.type);
  }

  close(): void {
    this.socket.close();
  }
}

function isType<T extends ServerMessage['type']>(
  m: ServerMessage,
  type: T,
): m is Extract<ServerMessage, { type: T }> {
  return m.type === type;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let counter = 0;
/** A fresh ULID-shaped betId for a test. */
export function betId(): string {
  counter += 1;
  return `01J9${String(counter).padStart(22, '0')}`;
}
