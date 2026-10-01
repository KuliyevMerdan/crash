import { curve as makeCurve, multiplierAt, type Curve } from '@crash/curve';
import type { Minor } from '@crash/money';
import {
  decodeFrame,
  parseServerMessage,
  type ClientMessage,
  type DevMessage,
  type ErrorMessage,
  type ServerMessage,
  type ServerMessageOf,
} from '@crash/protocol';
import { ClockSync } from './clock-sync.js';
import { ulid } from './ids.js';
import type { Clock, Connection, Scheduler, Timer, Transport } from './ports.js';
import { reduce, viewFromHello, type GameView } from './view.js';

/**
 * `connecting` — a socket is being opened · `authenticating` — open, waiting for `hello` ·
 * `live` — `hello` received, the view is current · `reconnecting` — the socket is gone and a new
 * one is scheduled · `closed` — `close()` was called; nothing more will happen.
 */
export type ConnectionStatus = 'connecting' | 'authenticating' | 'live' | 'reconnecting' | 'closed';

export interface ClientState {
  readonly status: ConnectionStatus;
  /** `null` until the first `hello`. Kept across a reconnect — stale, not blank — until the next one. */
  readonly game: GameView | null;
  /** Median offset (server − client) and rtt of the last five samples, `null` before the first. */
  readonly clock: { readonly offset: number | null; readonly rtt: number | null };
}

/** Why the state changed — for a UI that wants to react to the moment, not just the result. */
export type ClientEvent =
  | { readonly type: 'status'; readonly status: ConnectionStatus }
  | { readonly type: 'hello' }
  | { readonly type: 'message'; readonly message: ServerMessage }
  /** A message did not fit the view; a fresh `hello` has been asked for (§1, invariant 8). */
  | { readonly type: 'resync'; readonly cause: ServerMessage['type'] }
  /** A tick disagreed with the local curve by more than one step (§2.6) — deploy skew. */
  | { readonly type: 'drift'; readonly expected: number; readonly received: number }
  /** A frame of a known type failed its schema — the server speaks a different contract. */
  | {
      readonly type: 'protocol-error';
      readonly frameType: string;
      readonly issues: readonly string[];
    }
  /** The token was unknown to the server; the client started over with a new wallet. */
  | { readonly type: 'session-reset' };

export type Listener = (state: ClientState, event: ClientEvent) => void;

/** How a bet, a cancel or a cash-out ended. A `SYSTEM` error never ends one — it is retried. */
export type Outcome<T extends ServerMessage['type']> =
  | { readonly ok: true; readonly betId: string; readonly reply: ServerMessageOf<T> }
  | { readonly ok: false; readonly betId: string; readonly error: ErrorMessage }
  | { readonly ok: false; readonly betId: string; readonly error: null; readonly reason: 'closed' };

export interface ClientOptions {
  readonly transport: Transport;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly nick: string;
  /** A token from an earlier visit (§2.1). `null` asks the server for a new wallet. */
  readonly token?: string | null;
  /** Called with every token the server issues, for the caller to persist. */
  readonly onToken?: (token: string) => void;
  /** For `betId`s and backoff jitter — injected so a test replays exactly. */
  readonly random?: () => number;
  /** Liveness ping, and a clock sample each time. Three missed pongs and the socket is dropped. */
  readonly pingIntervalMs?: number;
  /** A request with no reply after this long is sent again — the same message, the same `betId`. */
  readonly requestTimeoutMs?: number;
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
}

type Kind = 'placeBet' | 'cancelBet' | 'cashOut';
const REPLY: Record<Kind, 'betAccepted' | 'betCancelled' | 'cashOutResult'> = {
  placeBet: 'betAccepted',
  cancelBet: 'betCancelled',
  cashOut: 'cashOutResult',
};

interface Intent {
  readonly kind: Kind;
  readonly betId: string;
  readonly message: ClientMessage;
  readonly resolve: (outcome: Outcome<ServerMessage['type']>) => void;
  timer: Timer | null;
}

const BURST = 5; // pings right after hello, so the offset is good before the first round is drawn
const BURST_SPACING_MS = 200;

/**
 * The client core: one socket, the view it keeps current, and the three things it can ask for.
 *
 * - **Reconnect is a new `hello`, nothing else** (§5, D6): the socket drops, the client backs off
 *   exponentially with jitter, authenticates with its token, and the snapshot restores the view —
 *   the round's phase, the table, its own bets, its balance. The multiplier needs no restoring: it
 *   is a function of `startedAt` and the synced clock.
 * - **A request is an intent with a `betId`**, generated once. A timeout, a `SYSTEM` error or a
 *   reconnect sends the *same* message again; the server's idempotency (§7) turns every repeat into
 *   the original answer. Only a reply or a `PLAYER` error ends an intent.
 * - **Liveness is the ping**: no `pong` for three intervals and the socket is treated as dead, even
 *   if it never said so — a half-open TCP connection looks healthy from this side forever.
 */
export class CrashClient {
  private state: ClientState = { status: 'closed', game: null, clock: { offset: null, rtt: null } };
  private readonly listeners = new Set<Listener>();
  private readonly sync = new ClockSync();
  private readonly intents = new Map<string, Intent>();
  private readonly random: () => number;
  private readonly pingIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly backoff: { initialMs: number; maxMs: number };

  private token: string | null;
  private connection: Connection | null = null;
  /** Bumped per connection attempt; events from an older attempt are ignored. */
  private generation = 0;
  private attempts = 0;
  private lastPongAt = 0;
  private pinger: Timer | null = null;
  /** From the open to the `hello` — the stretch the pings do not cover yet. */
  private helloDeadline: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private curve: Curve | null = null;
  private stopped = true;

  constructor(private readonly options: ClientOptions) {
    this.token = options.token ?? null;
    this.random = options.random ?? Math.random;
    this.pingIntervalMs = options.pingIntervalMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 4000;
    this.backoff = options.backoff ?? { initialMs: 250, maxMs: 8000 };
  }

  // ── Public surface ────────────────────────────────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Stop for good: close the socket, cancel every timer, end every pending request as `closed`. */
  close(): void {
    this.stopped = true;
    this.generation += 1;
    this.pinger?.cancel();
    this.helloDeadline?.cancel();
    this.reconnectTimer?.cancel();
    this.connection?.close();
    this.connection = null;
    for (const intent of this.intents.values()) {
      intent.timer?.cancel();
      intent.resolve({ ok: false, betId: intent.betId, error: null, reason: 'closed' });
    }
    this.intents.clear();
    this.setStatus('closed');
  }

  getState(): ClientState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The server's clock, as best this client knows it. */
  serverNow(): number {
    return this.options.clock.now() + (this.state.clock.offset ?? 0);
  }

  /** The multiplier the round shows right now, or `null` outside `RUNNING` (§3.1, invariant 4). */
  multiplier(): number | null {
    const round = this.state.game?.round;
    if (round?.phase !== 'RUNNING' || this.curve === null) return null;
    return multiplierAt(this.curve, this.serverNow() - round.startedAt);
  }

  /**
   * What a cash-out pressed now will most likely land on: the multiplier half a round trip from
   * now, when the press reaches the server (ADR-0002). A prediction, never a promise.
   */
  landingMultiplier(): number | null {
    const round = this.state.game?.round;
    if (round?.phase !== 'RUNNING' || this.curve === null) return null;
    const oneWay = (this.state.clock.rtt ?? 0) / 2;
    return multiplierAt(this.curve, this.serverNow() + oneWay - round.startedAt);
  }

  placeBet(amount: Minor, autoCashOutAt: number | null = null): Promise<Outcome<'betAccepted'>> {
    const game = this.state.game;
    const betId = ulid(this.options.clock.now(), this.random);
    return this.request(
      'placeBet',
      betId,
      { type: 'placeBet', betId, roundId: game?.round.roundId ?? '', amount, autoCashOutAt },
      'betAccepted',
    );
  }

  cancelBet(betId: string): Promise<Outcome<'betCancelled'>> {
    return this.request('cancelBet', betId, { type: 'cancelBet', betId }, 'betCancelled');
  }

  cashOut(betId: string): Promise<Outcome<'cashOutResult'>> {
    return this.request('cashOut', betId, { type: 'cashOut', betId }, 'cashOutResult');
  }

  /**
   * A dev message (docs/protocol.md §9) down this client's own socket — the debug panel's faults,
   * a load test's. A server that does not listen drops it as an unknown type; nothing is promised,
   * so nothing is awaited. `false` if there is no open socket to send it on.
   */
  sendDev(message: DevMessage): boolean {
    if (this.connection === null || this.state.status === 'connecting') return false;
    this.connection.send(JSON.stringify(message));
    return true;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────────────────────────

  private connect(): void {
    const generation = ++this.generation;
    this.setStatus('connecting');
    const live = () => generation === this.generation;
    this.connection = this.options.transport.connect({
      open: () => {
        if (!live()) return;
        this.setStatus('authenticating');
        this.authenticate();
        // Liveness is the ping, and pings start at hello: a link that goes dark between the open
        // and the hello needs its own deadline, the same three intervals, or "joining" is forever.
        this.helloDeadline?.cancel();
        this.helloDeadline = this.options.scheduler.setTimeout(() => {
          if (live() && this.state.status === 'authenticating') this.dropConnection();
        }, 3 * this.pingIntervalMs);
      },
      message: (frame) => {
        if (live()) this.onFrame(frame);
      },
      close: () => {
        if (live()) this.onDropped();
      },
    });
  }

  private onDropped(): void {
    if (this.stopped) return;
    this.generation += 1; // anything the old socket still says is ignored
    this.pinger?.cancel();
    this.helloDeadline?.cancel();
    this.connection = null;
    for (const intent of this.intents.values()) intent.timer?.cancel(); // re-sent after the next hello
    this.setStatus('reconnecting');
    const exponential = Math.min(this.backoff.maxMs, this.backoff.initialMs * 2 ** this.attempts);
    const delay = Math.round(exponential * (0.8 + 0.4 * this.random()));
    this.attempts += 1;
    this.reconnectTimer = this.options.scheduler.setTimeout(() => this.connect(), delay);
  }

  /** Drop the current socket as if the network had — used by liveness, and by tests. */
  dropConnection(): void {
    const connection = this.connection;
    this.onDropped();
    connection?.close();
  }

  private authenticate(): void {
    this.send({ type: 'authenticate', token: this.token, nick: this.options.nick });
  }

  private onFrame(frame: string): void {
    const outcome = parseServerMessage(decodeFrame(frame));
    if (outcome.kind === 'unknown-type') return; // invariant 9: dropped, not refused
    if (outcome.kind === 'malformed') {
      this.emit({ type: 'protocol-error', frameType: outcome.type, issues: outcome.issues });
      return;
    }
    const message = outcome.message;

    switch (message.type) {
      case 'hello':
        this.onHello(message);
        return;
      case 'pong':
        this.sync.add(message.clientTime, this.options.clock.now(), message.serverTime);
        this.lastPongAt = this.options.clock.now();
        this.state = { ...this.state, clock: { offset: this.sync.offset, rtt: this.sync.rtt } };
        this.emit({ type: 'message', message });
        return;
      case 'error':
        if (message.class === 'SESSION') {
          if (message.code === 'SESSION_INVALID') {
            this.token = null;
            this.emit({ type: 'session-reset' });
          }
          this.authenticate();
          return;
        }
        this.settleError(message);
        this.emit({ type: 'message', message });
        return;
      default:
        break;
    }

    const game = this.state.game;
    if (game === null) return;
    if (message.type === 'tick') this.checkDrift(message);
    const { view, resync } = reduce(game, message);
    this.state = { ...this.state, game: view };
    this.settleReply(message);
    if (resync) {
      this.emit({ type: 'resync', cause: message.type });
      this.authenticate(); // a fresh hello on the same socket
      return;
    }
    this.emit({ type: 'message', message });
  }

  private onHello(hello: ServerMessageOf<'hello'>): void {
    if (this.token !== hello.token) {
      this.token = hello.token;
      this.options.onToken?.(hello.token);
    }
    this.helloDeadline?.cancel();
    this.curve = makeCurve(hello.config.curve.growthRatePerSecond);
    this.attempts = 0;
    this.lastPongAt = this.options.clock.now();
    this.state = { ...this.state, status: 'live', game: viewFromHello(hello) };
    this.emit({ type: 'status', status: 'live' });
    this.emit({ type: 'hello' });
    this.startPings();
    for (const intent of this.intents.values()) this.transmit(intent); // after a reconnect: ask again
  }

  // ── Pings: clock samples and liveness ─────────────────────────────────────────────────────────

  private startPings(): void {
    this.pinger?.cancel();
    const generation = this.generation;
    let burst = 0;
    const next = () => {
      if (generation !== this.generation || this.state.status !== 'live') return;
      // Whole milliseconds on the wire: a browser clock (`performance.now`) is fractional, and the
      // protocol's timestamps are integers (§1) — a fractional `clientTime` is a malformed ping.
      const now = Math.floor(this.options.clock.now());
      if (now - this.lastPongAt > 3 * this.pingIntervalMs) {
        this.dropConnection(); // three intervals without a pong: the socket is dead, whatever it says
        return;
      }
      this.send({ type: 'ping', clientTime: now });
      burst += 1;
      this.pinger = this.options.scheduler.setTimeout(
        next,
        burst < BURST ? BURST_SPACING_MS : this.pingIntervalMs,
      );
    };
    next();
  }

  private checkDrift(tick: ServerMessageOf<'tick'>): void {
    if (this.curve === null) return;
    const expected = multiplierAt(this.curve, tick.elapsedMs);
    if (Math.abs(expected - tick.multiplier) > 1) {
      this.emit({ type: 'drift', expected, received: tick.multiplier });
    }
  }

  // ── Requests ──────────────────────────────────────────────────────────────────────────────────

  private async request<T extends ServerMessage['type']>(
    kind: Kind,
    betId: string,
    message: ClientMessage,
    reply: T,
  ): Promise<Outcome<T>> {
    const outcome = await this.enqueue(kind, betId, message);
    if (!outcome.ok) return outcome;
    if (isType(outcome.reply, reply))
      return { ok: true, betId: outcome.betId, reply: outcome.reply };
    throw new Error(`a ${kind} was settled by ${outcome.reply.type}`); // unreachable: settleReply matches REPLY[kind]
  }

  private enqueue(
    kind: Kind,
    betId: string,
    message: ClientMessage,
  ): Promise<Outcome<ServerMessage['type']>> {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve({ ok: false, betId, error: null, reason: 'closed' });
        return;
      }
      const key = `${kind}:${betId}`;
      const existing = this.intents.get(key);
      existing?.timer?.cancel();
      const intent: Intent = {
        kind,
        betId,
        message,
        resolve,
        timer: null,
      };
      this.intents.set(key, intent);
      if (this.state.status === 'live') this.transmit(intent);
    });
  }

  private transmit(intent: Intent): void {
    intent.timer?.cancel();
    this.send(intent.message);
    intent.timer = this.options.scheduler.setTimeout(() => {
      if (
        this.intents.get(`${intent.kind}:${intent.betId}`) === intent &&
        this.state.status === 'live'
      ) {
        this.transmit(intent); // no answer: the same message, the same betId (§7)
      }
    }, this.requestTimeoutMs);
  }

  private settleReply(message: ServerMessage): void {
    for (const kind of ['placeBet', 'cancelBet', 'cashOut'] as const) {
      if (message.type !== REPLY[kind] || !('betId' in message)) continue;
      const intent = this.intents.get(`${kind}:${message.betId}`);
      if (intent === undefined) continue;
      this.finish(intent, { ok: true, betId: intent.betId, reply: message });
    }
  }

  private settleError(error: ErrorMessage): void {
    if (error.betId === undefined) return;
    // The newest request for this bet is the one the refusal answers.
    const candidates = [...this.intents.values()].filter((i) => i.betId === error.betId);
    const intent = candidates[candidates.length - 1];
    if (intent === undefined) return;
    if (error.class === 'PLAYER') {
      this.finish(intent, { ok: false, betId: intent.betId, error });
    } else {
      // SYSTEM: retry under the same betId, never a new one (§6) — after a pause, not in a loop.
      intent.timer?.cancel();
      intent.timer = this.options.scheduler.setTimeout(() => {
        if (this.state.status === 'live') this.transmit(intent);
      }, this.backoff.initialMs);
    }
  }

  private finish(intent: Intent, outcome: Outcome<ServerMessage['type']>): void {
    intent.timer?.cancel();
    this.intents.delete(`${intent.kind}:${intent.betId}`);
    intent.resolve(outcome);
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────────────────────────

  private send(message: ClientMessage): void {
    this.connection?.send(JSON.stringify(message));
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.state.status === status) return;
    this.state = { ...this.state, status };
    this.emit({ type: 'status', status });
  }

  private emit(event: ClientEvent): void {
    for (const listener of this.listeners) listener(this.state, event);
  }
}

function isType<T extends ServerMessage['type']>(
  message: ServerMessage,
  type: T,
): message is ServerMessageOf<T> {
  return message.type === type;
}
