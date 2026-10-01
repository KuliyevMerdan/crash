import {
  CrashClient,
  type Clock,
  type GameView,
  type Scheduler,
  type Timer,
  type Transport,
} from '@crash/client-core';
import { curve as makeCurve, elapsedAt, type Curve } from '@crash/curve';
import { minor } from '@crash/money';
import type { HistoryEntry, MyBet, RoundSnapshot } from '@crash/protocol';

/**
 * A crowd of players for ROADMAP P0: real `@crash/client-core` clients, each on its own link, each
 * with a habit, and a schedule of the faults a real crowd suffers — slow and lossy links, frozen
 * ones, ones that go dark without closing, clocks an hour off, and a reconnect storm.
 *
 * Nothing here knows whether time is real. The same population runs in `tests/soak.test.ts` against
 * the real game server in virtual time, and in `pnpm load` against a server process over real
 * sockets; only the links, the clock and the scheduler differ.
 */

/** A transport whose network can also go dark under a live connection. */
export interface Link extends Transport {
  /** Nothing arrives either way from now on, and nothing says so — a half-open connection. */
  blackhole(): void;
}

/**
 * How a player's network behaves, applied with `devFaults` on every connection it makes (the
 * server's lanes, docs/protocol.md §9, D17): `clean` · `far` (300 ms round trip) · `lossy` (80 ms,
 * and 20% of frames resent).
 */
export type Profile = 'clean' | 'far' | 'lossy';
export const PROFILE_FAULTS: Record<Profile, { latencyMs: number; lossRate: number }> = {
  clean: { latencyMs: 0, lossRate: 0 },
  far: { latencyMs: 150, lossRate: 0 },
  lossy: { latencyMs: 40, lossRate: 0.2 },
};

export interface Bot {
  readonly index: number;
  readonly nick: string;
  readonly profile: Profile;
  /** The bot's clock minus the true one — some are an hour off, both ways. */
  readonly skewMs: number;
  readonly client: CrashClient;
  readonly link: Link;
}

export interface PopulationOptions {
  readonly size: number;
  readonly link: (index: number) => Link;
  /** The true clock — the one the server reads, for measurements. Bots get it plus their skew. */
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly random: () => number;
  /** Shares of the crowd on a `far` and a `lossy` link; the rest are `clean`. */
  readonly far?: number;
  readonly lossy?: number;
  /** Share of the crowd whose clock is an hour off. */
  readonly skewed?: number;
  readonly pingIntervalMs?: number;
  /** Stagger the first connections over this long, as a crowd arrives. */
  readonly arrivalMs?: number;
}

/** What the crowd did — and what the network did to it — per profile. */
export interface Tally {
  bets: number;
  accepted: number;
  cancelled: number;
  manual: number;
  auto: number;
  tooLate: number;
  /** A bet refused because it reached the server after betting closed. */
  missedBetting: number;
  refused: Record<string, number>;
  resyncs: number;
  /** What did not fit the view, by message type. */
  resyncCauses: Record<string, number>;
  reconnects: number;
}

const emptyTally = (): Tally => ({
  bets: 0,
  accepted: 0,
  cancelled: 0,
  manual: 0,
  auto: 0,
  tooLate: 0,
  missedBetting: 0,
  refused: {},
  resyncs: 0,
  resyncCauses: {},
  reconnects: 0,
});

/**
 * What the crowd's links measure, in milliseconds, keyed `kind:profile:label`:
 *
 * - `fanout` — a tick's receipt on the true clock minus the moment the server made it
 *   (`startedAt + elapsedMs`): serialising, fanning out, the network, parsing.
 * - `stamp` — a ping's `serverTime`, which is its `receivedAt` (docs/protocol.md §8), minus the true
 *   moment it was sent: the uplink, plus however long the server took to get to the frame (ADR-0002).
 * - `window` — at the moment a `bettingOpen` reaches the bot, how long betting has left.
 *
 * `label` is whatever the caller is doing at the time — `steady`, `storm` — so the same link can be
 * read under different loads.
 */
export type SampleKind = 'fanout' | 'stamp' | 'window';

export class Population {
  readonly bots: Bot[] = [];
  readonly tally: Record<Profile, Tally> = {
    clean: emptyTally(),
    far: emptyTally(),
    lossy: emptyTally(),
  };
  readonly samples = new Map<string, number[]>();
  /** Labels the samples taken from now on. */
  label = 'steady';
  /** Only every `tickSampleEvery`-th bot samples ticks — enough for percentiles, light on memory. */
  tickSampleEvery = 1;
  /** Bots play while this is on; `quiesce` turns it off. */
  playing = true;
  /** Faults apply on every new connection while this is on. */
  faulty = true;
  /** Collect `samples` while this is on — a long soak does not need a sample per tick. */
  sampling = true;
  private curve: Curve | null = null;
  private readonly timers = new Set<Timer>();
  /**
   * A bot the schedule has broken — frozen, dark, dropped — measures the fault, not the server, so
   * it takes no samples until it is whole again: a stall's end, or its next hello.
   */
  private readonly impairedUntil = new Map<number, number>();
  /** The last things each bot heard, for a post-mortem: ticks and pongs left out. */
  private readonly traces = new Map<number, string[]>();
  private readonly random: () => number;

  constructor(private readonly options: PopulationOptions) {
    this.random = options.random;
    const far = options.far ?? 0.2;
    const lossy = options.lossy ?? 0.2;
    const skewed = options.skewed ?? 0.1;
    for (let index = 0; index < options.size; index += 1) {
      const draw = this.random();
      const profile: Profile = draw < far ? 'far' : draw < far + lossy ? 'lossy' : 'clean';
      const skewMs = this.random() < skewed ? (this.random() < 0.5 ? -1 : 1) * 3_600_000 : 0;
      const link = options.link(index);
      const client = new CrashClient({
        transport: link,
        clock: { now: () => options.clock.now() + skewMs },
        scheduler: options.scheduler,
        nick: `bot-${index}`,
        random: this.random,
        ...(options.pingIntervalMs === undefined ? {} : { pingIntervalMs: options.pingIntervalMs }),
      });
      const bot: Bot = { index, nick: `bot-${index}`, profile, skewMs, client, link };
      this.bots.push(bot);
      this.wire(bot);
    }
  }

  start(): void {
    const arrival = this.options.arrivalMs ?? 0;
    for (const bot of this.bots) {
      this.later(() => bot.client.start(), arrival * this.random());
    }
  }

  stop(): void {
    for (const timer of this.timers) timer.cancel();
    this.timers.clear();
    for (const bot of this.bots) bot.client.close();
  }

  // ── Faults ────────────────────────────────────────────────────────────────────────────────────

  /** A share of the crowd, drawn at random. */
  pick(share: number): Bot[] {
    return this.bots.filter(() => this.random() < share);
  }

  /** Freeze their links for `ms`, both ways (`devStall`). */
  stall(bots: readonly Bot[], ms: number): void {
    for (const bot of bots) {
      bot.client.sendDev({ type: 'devStall', ms });
      this.impair(bot, this.options.clock.now() + ms + 1000);
    }
  }

  /** Their networks go dark without a close: their own liveness must notice (§8). */
  blackhole(bots: readonly Bot[]): void {
    for (const bot of bots) {
      bot.link.blackhole();
      this.impair(bot, Number.POSITIVE_INFINITY);
    }
  }

  /** The server drops them all at once (`devDisconnect`) — a reconnect storm. */
  storm(bots: readonly Bot[]): void {
    for (const bot of bots) {
      bot.client.sendDev({ type: 'devDisconnect' });
      this.impair(bot, Number.POSITIVE_INFINITY);
    }
  }

  /** The last things a bot heard, oldest first. */
  traceOf(bot: Bot): readonly string[] {
    return this.traces.get(bot.index) ?? [];
  }

  private impair(bot: Bot, until: number): void {
    this.impairedUntil.set(bot.index, Math.max(this.impairedUntil.get(bot.index) ?? 0, until));
  }

  /**
   * Stop playing and stop breaking things: every link back to clean, no new bets. What is in
   * flight still lands; a dark link still has to be noticed and replaced by its client.
   */
  quiesce(): void {
    this.playing = false;
    this.faulty = false;
    for (const bot of this.bots) {
      bot.client.sendDev({ type: 'devFaults', ...PROFILE_FAULTS.clean });
    }
  }

  // ── Checking the crowd against the server ─────────────────────────────────────────────────────

  /**
   * Every bot held to the server's account of it: live, the same round, the same history, the
   * same wallet and the same bets. Empty means nobody is in a wrong state.
   */
  compare(truth: Truth): string[] {
    const wrong: string[] = [];
    const round = canonical(truth.round);
    const history = canonical(truth.history);
    for (const bot of this.bots) {
      const state = bot.client.getState();
      const view = state.game;
      const who = `${bot.nick} (${bot.profile}${bot.skewMs === 0 ? '' : ', clock ±1h'})`;
      if (state.status !== 'live' || view === null) {
        wrong.push(`${who}: ${state.status}`);
        continue;
      }
      const mine = truth.players.get(view.player.id);
      if (mine === undefined) wrong.push(`${who}: unknown to the server`);
      else {
        if (view.player.balance !== mine.balance)
          wrong.push(`${who}: balance ${view.player.balance}, server ${mine.balance}`);
        if (canonical(view.myBets) !== canonical(mine.myBets))
          wrong.push(`${who}: own bets differ`);
      }
      if (canonical(view.round) !== round) wrong.push(`${who}: round differs`);
      if (canonical(view.history) !== history) wrong.push(`${who}: history differs`);
    }
    return wrong;
  }

  // ── Habits ────────────────────────────────────────────────────────────────────────────────────

  private wire(bot: Bot): void {
    const tally = this.tally[bot.profile];
    const record = (kind: SampleKind, value: number) => {
      if (!this.sampling) return;
      if ((this.impairedUntil.get(bot.index) ?? 0) > this.options.clock.now()) return;
      const key = `${kind}:${bot.profile}:${this.label}`;
      let list = this.samples.get(key);
      if (list === undefined) this.samples.set(key, (list = []));
      list.push(value);
    };
    let lastBettingRound: string | null = null;
    const pressed = new Set<string>();
    const trace: string[] = [];
    this.traces.set(bot.index, trace);
    const note = (line: string) => {
      trace.push(`${Math.round(this.options.clock.now()) % 1_000_000} ${line}`);
      if (trace.length > 80) trace.shift();
    };
    bot.client.subscribe((state, event) => {
      const view = state.game;
      if (event.type === 'message') {
        const m = event.message;
        if (m.type !== 'tick' && m.type !== 'pong') {
          const rid = 'roundId' in m && typeof m.roundId === 'string' ? m.roundId.slice(-4) : '';
          const bid =
            'betId' in m && typeof m.betId === 'string' ? ` bet ${m.betId.slice(-4)}` : '';
          note(`${m.type} ${rid}${bid} · bal ${view?.player.balance}`);
        }
      } else if (event.type !== 'drift') {
        note(
          `${event.type}${'cause' in event ? ` ${event.cause}` : ''}${'status' in event ? ` ${event.status}` : ''} · bal ${view?.player.balance}`,
        );
      }
      if (event.type === 'status' && event.status === 'reconnecting') tally.reconnects += 1;
      if (event.type === 'resync') {
        tally.resyncs += 1;
        tally.resyncCauses[event.cause] = (tally.resyncCauses[event.cause] ?? 0) + 1;
      }
      if (event.type === 'hello' && view !== null) {
        this.impairedUntil.delete(bot.index);
        this.curve ??= makeCurve(view.config.curve.growthRatePerSecond);
        if (this.faulty && bot.profile !== 'clean') {
          bot.client.sendDev({ type: 'devFaults', ...PROFILE_FAULTS[bot.profile] });
        }
        if (view.round.phase === 'BETTING' && view.round.roundId !== lastBettingRound) {
          lastBettingRound = view.round.roundId;
          if (view.myBets.length === 0) this.maybeBet(bot, view);
        }
        if (view.round.phase === 'RUNNING') this.maybePress(bot, view, pressed);
        return;
      }
      if (event.type !== 'message' || view === null) return;
      const m = event.message;
      switch (m.type) {
        case 'bettingOpen':
          lastBettingRound = m.roundId;
          record('window', m.bettingClosesAt - bot.client.serverNow());
          this.maybeBet(bot, view);
          break;
        case 'roundStart':
          this.maybePress(bot, view, pressed);
          break;
        case 'tick':
          if (view.round.phase === 'RUNNING' && bot.index % this.tickSampleEvery === 0) {
            record('fanout', this.options.clock.now() - (view.round.startedAt + m.elapsedMs));
          }
          break;
        case 'pong':
          record('stamp', m.serverTime - (m.clientTime - bot.skewMs));
          break;
        case 'cashOutResult':
          if (m.reason === 'AUTO') tally.auto += 1;
          break;
        default:
          break;
      }
    });
  }

  /** Three bets in four rounds, at a random moment in the first two-thirds of the window. */
  private maybeBet(bot: Bot, view: GameView): void {
    if (!this.playing || view.round.phase !== 'BETTING' || this.random() >= 0.75) return;
    const roundId = view.round.roundId;
    const left = view.round.bettingClosesAt - bot.client.serverNow();
    const amount = minor(100 + Math.floor(this.random() * 1900));
    const auto = this.random() < 0.5 ? 110 + Math.floor(this.random() * 490) : null;
    const tally = this.tally[bot.profile];
    this.later(
      () => {
        const now = bot.client.getState().game;
        if (!this.playing || now?.round.roundId !== roundId || now.myBets.length > 0) return;
        tally.bets += 1;
        void bot.client.placeBet(amount, auto).then((outcome) => {
          if (outcome.ok) {
            tally.accepted += 1;
            if (this.random() < 0.08) this.maybeCancel(bot, outcome.betId);
          } else if (outcome.error !== null) this.refused(bot, outcome.error.code);
        });
      },
      Math.max(0, left) * (2 / 3) * this.random(),
    );
  }

  private maybeCancel(bot: Bot, betId: string): void {
    this.later(() => {
      if (bot.client.getState().game?.round.phase !== 'BETTING') return;
      void bot.client.cancelBet(betId).then((outcome) => {
        if (outcome.ok) this.tally[bot.profile].cancelled += 1;
        else if (outcome.error !== null) this.refused(bot, outcome.error.code);
      });
    }, 300 * this.random());
  }

  /** A bet with no auto cash-out is pressed when the curve reaches a target of the bot's choosing. */
  private maybePress(bot: Bot, view: GameView, pressed: Set<string>): void {
    const round = view.round;
    const bet = view.myBets[0];
    if (round.phase !== 'RUNNING' || bet?.status !== 'OPEN' || bet.autoCashOutAt !== null) return;
    // Once per bet: a reconnect's hello must not schedule a second press for the same one.
    if (this.curve === null || pressed.has(bet.betId)) return;
    pressed.add(bet.betId);
    const target = 110 + Math.floor(this.random() * 690);
    const at = round.startedAt + elapsedAt(this.curve, target);
    this.later(
      () => {
        const now = bot.client.getState().game;
        if (now?.round.roundId !== round.roundId || now.round.phase !== 'RUNNING') return;
        void bot.client.cashOut(bet.betId).then((outcome) => {
          if (outcome.ok) this.tally[bot.profile].manual += 1;
          else if (outcome.error !== null) this.refused(bot, outcome.error.code);
        });
      },
      Math.max(0, at - bot.client.serverNow()),
    );
  }

  private refused(bot: Bot, code: string): void {
    const tally = this.tally[bot.profile];
    tally.refused[code] = (tally.refused[code] ?? 0) + 1;
    if (code === 'TOO_LATE') tally.tooLate += 1;
    if (code === 'BETTING_CLOSED') tally.missedBetting += 1;
  }

  private later(fn: () => void, ms: number): void {
    const timer = this.options.scheduler.setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }
}

/** The server's own account — `/dev/audit` over HTTP, or the engine directly in a test. */
export interface Truth {
  readonly money: { readonly granted: number; readonly accounted: number };
  readonly round: RoundSnapshot;
  readonly history: readonly HistoryEntry[];
  readonly players: ReadonlyMap<
    string,
    { readonly balance: number; readonly myBets: readonly MyBet[] }
  >;
}

/** JSON with sorted keys, so two equal values from two sources compare equal as strings. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
