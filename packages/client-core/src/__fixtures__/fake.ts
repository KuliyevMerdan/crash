import { minor } from '@crash/money';
import type { ClientMessage, ServerMessage, ServerMessageOf } from '@crash/protocol';
import type {
  Clock,
  Connection,
  Scheduler,
  Timer,
  Transport,
  TransportHandlers,
} from '../ports.js';

/** Virtual time: timers run in order of their due moment when the test advances the clock. */
export class VirtualTime implements Scheduler {
  now = 1_755_400_000_000;
  private seq = 0;
  private timers: Array<{ at: number; seq: number; fn: () => void; live: boolean }> = [];

  setTimeout(fn: () => void, ms: number): Timer {
    const timer = { at: this.now + Math.max(0, ms), seq: this.seq++, fn, live: true };
    this.timers.push(timer);
    return { cancel: () => void (timer.live = false) };
  }

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      this.timers = this.timers.filter((t) => t.live);
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (next === undefined || next.at > until) break;
      next.live = false;
      this.now = next.at;
      next.fn();
    }
    this.now = until;
  }

  /** A clock reading this time plus a skew — the client's clock can be hours off the server's. */
  clock(skew = 0): Clock {
    return { now: () => this.now + skew };
  }
}

/**
 * A scripted server on the other end of an in-process link with configurable latency each way.
 * The test decides what it says; `received` is everything the client sent, parsed.
 */
export class FakeServer implements Transport {
  readonly received: ClientMessage[] = [];
  connections = 0;
  up = 0;
  down = 0;
  /** The server's own clock skew relative to virtual time (the client's is set on the client). */
  serverSkew = 0;
  autoPong = true;
  refuse = false;
  private handlers: TransportHandlers | null = null;
  private open = false;

  constructor(private readonly time: VirtualTime) {}

  connect(handlers: TransportHandlers): Connection {
    this.connections += 1;
    const mine = handlers;
    this.handlers = mine;
    this.open = false;
    this.time.setTimeout(() => {
      if (this.handlers !== mine) return;
      if (this.refuse) {
        mine.close();
        return;
      }
      this.open = true;
      mine.open();
    }, this.up);
    return {
      send: (frame) => {
        if (this.handlers !== mine || !this.open) return;
        this.time.setTimeout(() => this.onClientFrame(JSON.parse(frame)), this.up);
      },
      close: () => {
        if (this.handlers === mine) this.handlers = null;
      },
    };
  }

  private onClientFrame(message: ClientMessage): void {
    this.received.push(message);
    if (message.type === 'ping' && this.autoPong) {
      this.send({
        type: 'pong',
        clientTime: message.clientTime,
        serverTime: this.time.now + this.serverSkew,
      });
    }
  }

  send(message: ServerMessage | object): void {
    const handlers = this.handlers;
    this.time.setTimeout(() => {
      if (this.handlers === handlers) handlers?.message(JSON.stringify(message));
    }, this.down);
  }

  /** The network dies: the client hears a close, as it would from a browser socket. */
  drop(): void {
    const handlers = this.handlers;
    this.handlers = null;
    this.open = false;
    handlers?.close();
  }

  sent<T extends ClientMessage['type']>(type: T): Array<Extract<ClientMessage, { type: T }>> {
    return this.received.filter((m): m is Extract<ClientMessage, { type: T }> => m.type === type);
  }
}

export const ROUND = '01J8ZQ4Y6T3M9N2B7C5D1E0F0A';
export const NEXT_ROUND = '01J8ZQ4Y6T3M9N2B7C5D1E0F0B';
export const COMMIT = '9f2c1a3b5d7f9e1c3a5b7d9f1e3c5a7b9d1f3e5c7a9b1d3f5e7c9a1b3d5f7e9c';

export function hello(
  round: ServerMessageOf<'hello'>['round'],
  extra: Partial<ServerMessageOf<'hello'>> = {},
): ServerMessageOf<'hello'> {
  return {
    type: 'hello',
    token: 'tok_1',
    serverTime: 0,
    player: { id: 'p1', nick: 'ada', balance: minor(100_000) },
    config: {
      curve: { growthRatePerSecond: 0.15 },
      bettingPhaseMs: 7000,
      crashedPhaseMs: 3000,
      tickIntervalMs: 100,
      minBet: minor(100),
      maxBet: minor(50_000),
      maxAutoCashOut: 100_000,
      houseEdgeBps: 100,
    },
    chain: { id: 1, commit: COMMIT, salt: 'crash-demo-chain-1', length: 1_000_000 },
    round,
    myBets: [],
    history: [],
    ...extra,
  };
}

export const betting = (bettingClosesAt: number): ServerMessageOf<'hello'>['round'] => ({
  roundId: ROUND,
  chainIndex: 5,
  phase: 'BETTING',
  bettingClosesAt,
  bets: [],
});
