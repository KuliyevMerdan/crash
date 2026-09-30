import {
  createEngine,
  myBetsOf,
  nextDeadline,
  roundSnapshotOf,
  step,
  tickAt,
  type Effect,
  type EngineEvent,
  type EngineState,
} from '@crash/engine';
import { minor } from '@crash/money';
import {
  errorMessageOf,
  type ClientMessageOf,
  type ServerMessage,
  type ServerMessageOf,
} from '@crash/protocol';
import type { Logger } from 'pino';
import type { ChainBook } from './chains.js';
import { decodeEvent, decodeState, encodeEvent, encodeState } from './codec.js';
import type { ServerConfig } from './config.js';
import { token as newToken, ulid } from './ids.js';
import type { Store } from './store/store.js';
import type { Clock, Scheduler, Timer } from './time.js';

/** Where effects go. The socket layer implements it; the game never touches a socket. */
export interface Outbox {
  broadcast(message: ServerMessage): void;
  send(playerId: string, message: ServerMessage): void;
}

export interface GameDeps {
  readonly config: ServerConfig;
  readonly store: Store;
  readonly chains: ChainBook;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly log: Logger;
}

type PlayerMove =
  ClientMessageOf<'placeBet'> | ClientMessageOf<'cancelBet'> | ClientMessageOf<'cashOut'>;

/**
 * The round loop: it owns the clock, the timers and the engine's state, and nothing about the rules.
 *
 * Every change goes through `commit`, in one order that never varies:
 *
 * 1. **step** the engine — pure, so computing it commits to nothing;
 * 2. **persist** the event, and whatever it implies — a consumed chain link, a claimed `betId`, a
 *    checkpoint and a reveal at a crash — in **one transaction**;
 * 3. only then **adopt** the new state and **publish** its effects.
 *
 * So nothing reaches a socket that is not on disk, and a crash between (2) and (3) replays to the
 * same state on restart — the client's retry then gets its original answer (docs/protocol.md §7).
 */
export class Game {
  private state: EngineState;
  private outbox: Outbox = { broadcast() {}, send() {} };
  private deadline: Timer | null = null;
  private ticker: Timer | null = null;
  private forcedNext: number | null = null;
  private running = false;

  private constructor(private readonly deps: GameDeps) {
    this.state = Game.restore(deps);
  }

  /**
   * The engine as it was: the last checkpoint, with every journaled event since replayed through
   * the pure engine. Auto cash-outs and a crash that fell due while the server was down are then
   * settled at their scheduled moments by the first `advance` — the downtime changes no number.
   */
  private static restore({ store, config, log }: GameDeps): EngineState {
    const checkpoint = store.readCheckpoint();
    let state =
      checkpoint === null ? createEngine(config.game) : decodeState(checkpoint, config.game);
    const journal = store.readJournal();
    for (const entry of journal) state = step(state, decodeEvent(entry.event), entry.now).state;
    log.info(
      { checkpoint: checkpoint !== null, replayed: journal.length, roundId: state.round?.roundId },
      'engine restored',
    );
    return state;
  }

  static create(deps: GameDeps): Game {
    return new Game(deps);
  }

  /** Start the loop: settle anything that fell due while stopped, open a round if one is due, arm. */
  start(outbox: Outbox): void {
    this.outbox = outbox;
    this.running = true;
    this.commit({ type: 'advance' }, this.now());
    this.onDeadline();
    this.ticker = this.deps.scheduler.setInterval(
      () => this.tick(),
      this.deps.config.game.tickIntervalMs,
    );
  }

  stop(): void {
    this.running = false;
    this.deadline?.cancel();
    this.ticker?.cancel();
    this.deadline = null;
    this.ticker = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The engine's state — read-only, for `/ready` and tests. */
  get snapshot(): EngineState {
    return this.state;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────────────────────

  /**
   * `authenticate` (§2.1): a null token makes a new wallet; a known token resumes one; an unknown
   * token is `SESSION_INVALID`, and the client starts over with `null`.
   */
  authenticate(token: string | null, nick: string): { token: string; playerId: string } | null {
    const now = this.now();
    if (token === null) {
      const playerId = ulid(now);
      const issued = newToken();
      this.commit(
        { type: 'addPlayer', playerId, nick, balance: minor(this.deps.config.startingBalance) },
        now,
        () => this.deps.store.addSession(issued, playerId),
      );
      return { token: issued, playerId };
    }
    const playerId = this.deps.store.playerForToken(token);
    if (playerId === null || !this.state.players.has(playerId)) return null;
    if (this.state.players.get(playerId)?.nick !== nick) {
      this.commit({ type: 'renamePlayer', playerId, nick }, now);
    }
    return { token, playerId };
  }

  /** The full snapshot a (re)connecting client needs and nothing else (§2.2). */
  hello(playerId: string, token: string): ServerMessageOf<'hello'> {
    const round = roundSnapshotOf(this.state);
    const player = this.state.players.get(playerId);
    if (round === null || player === undefined) throw new Error('hello before the first round');
    return {
      type: 'hello',
      token,
      serverTime: this.now(),
      player: { id: player.id, nick: player.nick, balance: player.balance },
      config: this.deps.config.game,
      chain: this.deps.chains.info(),
      round,
      myBets: myBetsOf(this.state, playerId),
      history: [...this.state.history],
    };
  }

  // ── Player moves ──────────────────────────────────────────────────────────────────────────────

  /**
   * A bet, a cancel or a cash-out, judged at `receivedAt` — stamped by the socket layer when the
   * frame arrived, before it was parsed (ADR-0002).
   */
  submit(playerId: string, move: PlayerMove, receivedAt: number): void {
    const now = Math.max(receivedAt, this.state.now);
    switch (move.type) {
      case 'placeBet': {
        // The engine remembers one round back; the store remembers every betId ever accepted.
        if (this.deps.store.hasBetId(move.betId) && !this.engineKnows(move.betId)) {
          this.outbox.send(
            playerId,
            errorMessageOf('DUPLICATE_BET_ID', 'this betId has been used', {
              roundId: move.roundId,
              betId: move.betId,
            }),
          );
          return;
        }
        this.commit(
          {
            type: 'placeBet',
            playerId,
            betId: move.betId,
            roundId: move.roundId,
            amount: move.amount,
            autoCashOutAt: move.autoCashOutAt,
          },
          now,
        );
        return;
      }
      case 'cancelBet':
        this.commit({ type: 'cancelBet', playerId, betId: move.betId }, now);
        return;
      case 'cashOut':
        this.commit({ type: 'cashOut', playerId, betId: move.betId }, now);
        return;
    }
  }

  /** `devForceCrashPoint` (§9) — the socket layer only calls this on a development server. */
  forceNext(crashPoint: number): void {
    this.forcedNext = crashPoint;
    this.deps.log.warn({ crashPoint }, 'next round forced (development)');
  }

  // ── The loop ──────────────────────────────────────────────────────────────────────────────────

  private commit(event: EngineEvent, now: number, alsoWrite?: () => void): void {
    const { store, chains, log } = this.deps;
    const result = step(this.state, event, now);
    const crash = result.effects.find((e) => e.message.type === 'crash');

    store.transaction(() => {
      if (event.type !== 'advance') store.append({ now, event: encodeEvent(event) });
      alsoWrite?.();
      if (event.type === 'openRound' && event.source.kind === 'chain') {
        store.setConsumed(event.source.chain.id, event.source.chainIndex);
      }
      for (const effect of result.effects) {
        if (effect.message.type === 'betPlaced') {
          const bet = result.state.round?.bets.get(effect.message.betId);
          if (bet !== undefined) store.claimBetId(bet.betId, bet.playerId);
        }
      }
      if (crash !== undefined) {
        store.writeCheckpoint(encodeState(result.state));
        const round = result.state.round;
        if (round?.phase === 'CRASHED' && round.link !== null) {
          store.addReveal({ ...round.link, roundId: round.roundId, crashPoint: round.crashPoint });
        }
      }
    });

    this.state = result.state;
    this.logEffects(result.effects);
    for (const effect of result.effects) this.deliver(effect);

    if (crash !== undefined) {
      // The pause after a crash is the one moment nothing is in flight to be stamped late, so a
      // chain rotation's ≈0.7 s of hashing happens here and nowhere else.
      chains.rotateIfDue();
      log.info(
        { roundId: this.state.round?.roundId, house: this.state.house },
        'checkpoint written',
      );
    }
    if (this.running) this.arm();
  }

  private arm(): void {
    this.deadline?.cancel();
    const { at } = nextDeadline(this.state);
    this.deadline = this.deps.scheduler.setTimeout(
      () => this.onDeadline(),
      Math.max(0, at - this.now()),
    );
  }

  private onDeadline(): void {
    if (!this.running) return;
    const now = this.now();
    const { at, due } = nextDeadline(this.state);
    if (at > now) {
      this.arm(); // woke early — the deadline moved
      return;
    }
    if (due === 'advance') {
      this.commit({ type: 'advance' }, now);
    } else {
      this.openRound(now);
    }
  }

  private openRound(now: number): void {
    const roundId = ulid(now);
    const forced = this.forcedNext;
    this.forcedNext = null;
    const source =
      forced === null
        ? ({ kind: 'chain', ...this.deps.chains.next() } as const)
        : ({ kind: 'forced', crashPoint: forced } as const);
    this.commit({ type: 'openRound', roundId, source }, now);
  }

  private tick(): void {
    if (this.state.round?.phase !== 'RUNNING') return;
    const now = this.now();
    if (nextDeadline(this.state).at <= now) this.commit({ type: 'advance' }, now);
    const tick = tickAt(this.state, now);
    if (tick !== null) this.outbox.broadcast(tick);
  }

  private deliver(effect: Effect): void {
    if (effect.kind === 'broadcast') this.outbox.broadcast(effect.message);
    else this.outbox.send(effect.playerId, effect.message);
  }

  private engineKnows(betId: string): boolean {
    return Boolean(this.state.round?.bets.has(betId) || this.state.previous?.bets.has(betId));
  }

  private now(): number {
    return Math.max(this.deps.clock.now(), this.state.now);
  }

  /**
   * One line per thing that happened, keyed by `roundId`. **Never a seed before its reveal** — the
   * only line that carries one is the crash, where it is already public (`game.test.ts` asserts it).
   */
  private logEffects(effects: readonly Effect[]): void {
    const { log } = this.deps;
    for (const { message } of effects) {
      switch (message.type) {
        case 'bettingOpen':
          log.info({ roundId: message.roundId, chainIndex: message.chainIndex }, 'round opened');
          break;
        case 'roundStart':
          log.info({ roundId: message.roundId, startedAt: message.startedAt }, 'round started');
          break;
        case 'betPlaced':
          log.info(
            { roundId: message.roundId, betId: message.betId, amount: message.amount },
            'bet placed',
          );
          break;
        case 'playerCashedOut':
          log.info(
            { roundId: message.roundId, betId: message.betId, multiplier: message.multiplier },
            'cashed out',
          );
          break;
        case 'crash':
          log.info(
            {
              roundId: message.roundId,
              crashPoint: message.crashPoint,
              fair: message.fair,
              bets: message.settled.length,
            },
            'round crashed',
          );
          break;
        case 'error':
          log.info(
            { roundId: message.roundId, betId: message.betId, code: message.code },
            'move refused',
          );
          break;
        default:
          break;
      }
    }
  }
}
