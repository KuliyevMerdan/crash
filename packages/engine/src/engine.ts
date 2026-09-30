import { curve as makeCurve, elapsedAt, multiplierAt } from '@crash/curve';
import { crashPoint as crashPointOf, verifyLink } from '@crash/fair';
import { add, payout as payoutOf, sub, ZERO, type Minor } from '@crash/money';
import {
  errorMessageOf,
  type ErrorCode,
  type GameConfig,
  type HistoryEntry,
  type MyBet,
  type RoundSnapshot,
  type ServerMessage,
  type ServerMessageOf,
} from '@crash/protocol';
import type {
  AutoCashOut,
  Bet,
  ChainLink,
  CrashedRound,
  Effect,
  EngineEvent,
  EngineState,
  Player,
  PlayerId,
  Round,
  Step,
} from './types.js';

/** How many past crash points `hello.history` carries. */
export const HISTORY_LENGTH = 30;

/**
 * A mistake by the **caller** — the server's loop or the sim — not by a player. Players never cause
 * one: everything a player can send is answered with an `error` effect. An `EngineError` means the
 * code driving the engine is wrong, and the right response is to stop and fix it.
 */
export class EngineError extends Error {
  override readonly name = 'EngineError';
}

export function createEngine(config: GameConfig): EngineState {
  return {
    config,
    curve: makeCurve(config.curve.growthRatePerSecond),
    players: new Map(),
    round: null,
    previous: null,
    history: [],
    granted: ZERO,
    house: ZERO,
    now: 0,
  };
}

/**
 * `(state, event, now) → (state, effects)` — the whole engine.
 *
 * Every step first brings the round up to `now`: closing betting, firing auto cash-outs and busting
 * at the moments they were **scheduled**, not the moment the caller got round to asking. So a
 * server timer that fires late changes nothing — not `startedAt`, not the crash moment, not what an
 * auto cash-out pays — and an event received at `now` is judged against everything that was due
 * before it (ADR-0002: receive order is the order).
 */
export function step(state: EngineState, event: EngineEvent, now: number): Step {
  if (!Number.isSafeInteger(now) || now < 0) throw new EngineError(`now must be a time: ${now}`);
  if (now < state.now) {
    throw new EngineError(`time ran backwards: ${now} after ${state.now} (ADR-0002)`);
  }
  const out: Effect[] = [];
  let s: EngineState = settleDue({ ...state, now }, now, out);

  switch (event.type) {
    case 'addPlayer':
      s = addPlayer(s, event.playerId, event.nick, event.balance);
      break;
    case 'renamePlayer':
      s = renamePlayer(s, event.playerId, event.nick);
      break;
    case 'openRound':
      s = openRound(s, event, now, out);
      break;
    case 'placeBet':
      s = placeBet(s, event, now, out);
      break;
    case 'cancelBet':
      s = cancelBet(s, event, out);
      break;
    case 'cashOut':
      s = cashOut(s, event, now, out);
      break;
    case 'advance':
      break;
    default:
      return assertNever(event);
  }
  return { state: s, effects: out };
}

// ── Time ─────────────────────────────────────────────────────────────────────────────────────────

function settleDue(state: EngineState, now: number, out: Effect[]): EngineState {
  let s = state;
  const betting = s.round;
  if (betting?.phase === 'BETTING' && now >= betting.bettingClosesAt) s = start(s, betting, out);

  const running = s.round;
  if (running?.phase !== 'RUNNING') return s;
  for (const auto of running.autos) {
    if (auto.fireAt > now) break;
    const bet = currentBet(s, auto.betId);
    if (bet?.status === 'OPEN' && bet.autoCashOutAt !== null) {
      s = settleCashOut(s, bet, 'AUTO', bet.autoCashOutAt, auto.fireAt, out);
    }
  }
  return now >= running.crashAt ? crash(s, out) : s;
}

function start(
  s: EngineState,
  round: Extract<Round, { phase: 'BETTING' }>,
  out: Effect[],
): EngineState {
  // Betting closes at its scheduled moment, and that moment is the start — however late the
  // caller's timer fired.
  const startedAt = round.bettingClosesAt;
  const crashAt = startedAt + elapsedAt(s.curve, round.crashPoint);

  const autos: AutoCashOut[] = [];
  for (const bet of round.bets.values()) {
    if (bet.status !== 'OPEN' || bet.autoCashOutAt === null) continue;
    // A target at or below the crash point wins — the curve reached it — and one above never does
    // (§4, D14). Decided on the values, not the moments: past ~66× the curve moves more than a
    // hundredth per millisecond, so a target just under the crash point is first reached *at* the
    // crash moment. It fires there, before the bust, because settleDue fires autos first.
    if (bet.autoCashOutAt > round.crashPoint) continue;
    autos.push({ betId: bet.betId, fireAt: startedAt + elapsedAt(s.curve, bet.autoCashOutAt) });
  }
  autos.sort((a, b) => a.fireAt - b.fireAt); // stable: equal moments keep placement order

  out.push(broadcast({ type: 'roundStart', roundId: round.roundId, startedAt }));
  return { ...s, round: { ...round, phase: 'RUNNING', startedAt, crashAt, autos } };
}

function crash(s: EngineState, out: Effect[]): EngineState {
  const round = s.round;
  if (round?.phase !== 'RUNNING') throw new EngineError('crash outside RUNNING'); // unreachable
  const crashedAt = round.crashAt;

  let house = s.house;
  const bets = new Map<string, Bet>();
  for (const [betId, bet] of round.bets) {
    if (bet.status === 'OPEN') {
      house = add(house, bet.amount); // a stake still riding at the bust is the house's
      bets.set(betId, { ...baseOf(bet), status: 'LOST' });
    } else {
      bets.set(betId, bet);
    }
  }

  const crashed: CrashedRound = {
    roundId: round.roundId,
    link: round.link,
    crashPoint: round.crashPoint,
    bettingClosesAt: round.bettingClosesAt,
    bets,
    phase: 'CRASHED',
    startedAt: round.startedAt,
    crashedAt,
  };

  out.push(
    broadcast({
      type: 'crash',
      roundId: round.roundId,
      crashPoint: round.crashPoint,
      crashedAt,
      fair: revealOf(crashed),
      settled: [...bets.values()]
        .filter((bet) => bet.status !== 'CANCELLED')
        .map((bet) => ({ betId: bet.betId, nick: bet.nick, won: bet.status === 'CASHED_OUT' })),
    }),
  );

  const entry: HistoryEntry = { roundId: round.roundId, crashPoint: round.crashPoint };
  return {
    ...s,
    round: crashed,
    house,
    history: [entry, ...s.history].slice(0, HISTORY_LENGTH),
  };
}

// ── Caller events ────────────────────────────────────────────────────────────────────────────────

function addPlayer(s: EngineState, id: PlayerId, nick: string, balance: Minor): EngineState {
  if (s.players.has(id)) throw new EngineError(`player ${id} already exists`);
  if (balance < 0) throw new EngineError(`a starting balance cannot be negative: ${balance}`);
  return {
    ...s,
    players: new Map(s.players).set(id, { id, nick, balance }),
    granted: add(s.granted, balance),
  };
}

function renamePlayer(s: EngineState, id: PlayerId, nick: string): EngineState {
  const player = s.players.get(id);
  if (player === undefined) throw new EngineError(`no player ${id}`);
  return withPlayer(s, { ...player, nick });
}

function openRound(
  s: EngineState,
  event: Extract<EngineEvent, { type: 'openRound' }>,
  now: number,
  out: Effect[],
): EngineState {
  const round = s.round;
  if (round?.phase === 'BETTING' || round?.phase === 'RUNNING') {
    throw new EngineError(`cannot open a round while ${round.roundId} is ${round.phase}`);
  }
  if (round?.phase === 'CRASHED' && now < round.crashedAt + s.config.crashedPhaseMs) {
    throw new EngineError(
      `the pause after ${round.roundId} runs until ${round.crashedAt + s.config.crashedPhaseMs}`,
    );
  }
  const { source } = event;
  let link: ChainLink | null = null;
  let crashPoint: number;
  if (source.kind === 'chain') {
    // The reveal must verify, so refuse a seed that does not link to its claimed predecessor now,
    // rather than publish a round a stranger will catch later.
    if (!verifyLink(source.seed, source.previousHash)) {
      throw new EngineError(`seed for chain ${source.chain.id}:${source.chainIndex} does not link`);
    }
    link = {
      chainId: source.chain.id,
      chainIndex: source.chainIndex,
      seed: source.seed,
      previousHash: source.previousHash,
    };
    // Decided here — before betting opens, before any bet exists (ADR-0001).
    crashPoint = crashPointOf(source.seed, source.chain.salt, s.config.houseEdgeBps);
  } else {
    // A forced dev round (§9): the caller only builds one on a development server.
    if (
      !Number.isInteger(source.crashPoint) ||
      source.crashPoint < 100 ||
      source.crashPoint > 100_000_000
    ) {
      throw new EngineError(`not a crash point: ${source.crashPoint}`);
    }
    crashPoint = source.crashPoint;
  }
  const bettingClosesAt = now + s.config.bettingPhaseMs;

  out.push(
    broadcast({
      type: 'bettingOpen',
      roundId: event.roundId,
      chainIndex: link?.chainIndex ?? null,
      bettingClosesAt,
    }),
  );
  return {
    ...s,
    previous: round ?? null,
    round: {
      phase: 'BETTING',
      roundId: event.roundId,
      link,
      crashPoint,
      bettingClosesAt,
      bets: new Map(),
    },
  };
}

// ── Player events ────────────────────────────────────────────────────────────────────────────────

function placeBet(
  s: EngineState,
  event: Extract<EngineEvent, { type: 'placeBet' }>,
  now: number,
  out: Effect[],
): EngineState {
  const player = s.players.get(event.playerId);
  if (player === undefined) return internal(s, event.playerId, out);
  const ids = { roundId: event.roundId, betId: event.betId };

  const known = findBet(s, event.betId);
  if (known !== undefined) {
    const { bet, roundId } = known;
    // A betId is single-use: someone else's, a cancelled one, or one from another round is a
    // duplicate. The same bet in the same round is a retry, and gets its original answer (§7).
    if (
      bet.playerId !== event.playerId ||
      bet.status === 'CANCELLED' ||
      roundId !== event.roundId
    ) {
      return reject(s, event.playerId, 'DUPLICATE_BET_ID', 'this betId has been used', ids, out);
    }
    out.push(send(event.playerId, acceptedOf(roundId, bet)));
    return s;
  }

  const round = s.round;
  if (
    round?.phase !== 'BETTING' ||
    round.roundId !== event.roundId ||
    now >= round.bettingClosesAt
  ) {
    return reject(
      s,
      event.playerId,
      'BETTING_CLOSED',
      'betting is closed for that round',
      ids,
      out,
    );
  }
  const { minBet, maxBet, maxAutoCashOut } = s.config;
  if (event.amount < minBet || event.amount > maxBet) {
    return reject(s, event.playerId, 'BET_OUT_OF_RANGE', `bets are ${minBet}–${maxBet}`, ids, out);
  }
  if (
    event.autoCashOutAt !== null &&
    (event.autoCashOutAt < 101 || event.autoCashOutAt > maxAutoCashOut)
  ) {
    return reject(
      s,
      event.playerId,
      'AUTO_CASHOUT_OUT_OF_RANGE',
      `auto cash-out is 101–${maxAutoCashOut}`,
      ids,
      out,
    );
  }
  for (const bet of round.bets.values()) {
    if (bet.playerId === event.playerId && bet.status !== 'CANCELLED') {
      return reject(s, event.playerId, 'ONE_BET_PER_ROUND', 'one bet per round', ids, out);
    }
  }
  if (player.balance < event.amount) {
    return reject(s, event.playerId, 'INSUFFICIENT_FUNDS', 'not enough balance', ids, out);
  }

  const balance = sub(player.balance, event.amount);
  const bet: Bet = {
    betId: event.betId,
    playerId: event.playerId,
    nick: player.nick,
    amount: event.amount,
    autoCashOutAt: event.autoCashOutAt,
    acceptedBalance: balance,
    status: 'OPEN',
  };
  out.push(send(event.playerId, acceptedOf(round.roundId, bet)));
  out.push(
    broadcast({
      type: 'betPlaced',
      roundId: round.roundId,
      betId: bet.betId,
      nick: bet.nick,
      amount: bet.amount,
    }),
  );
  return withPlayer(withBet(s, bet), { ...player, balance });
}

function cancelBet(
  s: EngineState,
  event: Extract<EngineEvent, { type: 'cancelBet' }>,
  out: Effect[],
): EngineState {
  const player = s.players.get(event.playerId);
  if (player === undefined) return internal(s, event.playerId, out);

  const known = findBet(s, event.betId);
  if (known === undefined || known.bet.playerId !== event.playerId) {
    return reject(s, event.playerId, 'UNKNOWN_BET', 'no such bet', { betId: event.betId }, out);
  }
  const { bet, roundId } = known;
  const ids = { roundId, betId: bet.betId };
  if (bet.status === 'CANCELLED') {
    out.push(send(event.playerId, cancelledOf(roundId, bet.betId, bet.cancelledBalance)));
    return s;
  }
  if (bet.status !== 'OPEN' || s.round?.phase !== 'BETTING' || s.round.roundId !== roundId) {
    return reject(
      s,
      event.playerId,
      'BETTING_CLOSED',
      'betting is closed for that round',
      ids,
      out,
    );
  }

  const balance = add(player.balance, bet.amount);
  out.push(send(event.playerId, cancelledOf(roundId, bet.betId, balance)));
  out.push(broadcast({ type: 'betWithdrawn', roundId, betId: bet.betId }));
  return withPlayer(
    withBet(s, { ...baseOf(bet), status: 'CANCELLED', cancelledBalance: balance }),
    { ...player, balance },
  );
}

function cashOut(
  s: EngineState,
  event: Extract<EngineEvent, { type: 'cashOut' }>,
  now: number,
  out: Effect[],
): EngineState {
  if (!s.players.has(event.playerId)) return internal(s, event.playerId, out);

  const known = findBet(s, event.betId);
  // A cancelled bet never happened (§2.10); someone else's is not this player's to touch.
  if (
    known === undefined ||
    known.bet.playerId !== event.playerId ||
    known.bet.status === 'CANCELLED'
  ) {
    return reject(s, event.playerId, 'UNKNOWN_BET', 'no such bet', { betId: event.betId }, out);
  }
  const { bet, roundId } = known;
  const ids = { roundId, betId: bet.betId };

  switch (bet.status) {
    case 'CASHED_OUT':
      // A retry cannot improve or destroy a resolution (§7) — and an auto cash-out that beat the
      // press answers the press, with `reason: "AUTO"`.
      out.push(send(event.playerId, cashOutResultOf(roundId, bet)));
      return s;
    case 'LOST':
      return reject(s, event.playerId, 'TOO_LATE', 'the round crashed first', ids, out);
    case 'OPEN': {
      const round = s.round;
      if (round?.phase === 'BETTING') {
        return reject(s, event.playerId, 'NOT_RUNNING', 'the round has not started', ids, out);
      }
      if (round?.phase !== 'RUNNING')
        throw new EngineError(`open bet ${bet.betId} outside a round`);
      // settleDue ran first, so `now < crashAt` here: a press at the crash moment already lost.
      const multiplier = multiplierAt(s.curve, now - round.startedAt);
      return settleCashOut(s, bet, 'MANUAL', multiplier, now, out);
    }
    default:
      return assertNever(bet);
  }
}

function settleCashOut(
  s: EngineState,
  bet: Extract<Bet, { status: 'OPEN' }>,
  reason: 'MANUAL' | 'AUTO',
  multiplier: number,
  at: number,
  out: Effect[],
): EngineState {
  const player = s.players.get(bet.playerId);
  if (player === undefined) throw new EngineError(`bet ${bet.betId} belongs to no player`);
  const round = s.round;
  if (round === null) throw new EngineError('cash-out outside a round'); // unreachable

  const paid = payoutOf(bet.amount, multiplier);
  const balance = add(player.balance, paid);
  const settled: Bet = {
    ...baseOf(bet),
    status: 'CASHED_OUT',
    reason,
    multiplier,
    payout: paid,
    cashOutBalance: balance,
    cashedOutAt: at,
  };
  out.push(send(bet.playerId, cashOutResultOf(round.roundId, settled)));
  out.push(
    broadcast({
      type: 'playerCashedOut',
      roundId: round.roundId,
      betId: bet.betId,
      nick: bet.nick,
      multiplier,
    }),
  );
  return {
    ...withPlayer(withBet(s, settled), { ...player, balance }),
    house: add(s.house, sub(bet.amount, paid)),
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

/**
 * When the caller must next act, and how. The server arms one timer for `at`; the sim jumps
 * straight to it. `openRound` is due immediately before the first round, and after each crash once
 * the pause has run — the caller brings the seed, since it holds the chain.
 */
export function nextDeadline(s: EngineState): {
  readonly at: number;
  readonly due: 'advance' | 'openRound';
} {
  const round = s.round;
  switch (round?.phase) {
    case undefined:
      return { at: s.now, due: 'openRound' };
    case 'BETTING':
      return { at: round.bettingClosesAt, due: 'advance' };
    case 'RUNNING': {
      const auto = round.autos.find((a) => a.fireAt > s.now);
      return {
        at: auto === undefined ? round.crashAt : Math.min(auto.fireAt, round.crashAt),
        due: 'advance',
      };
    }
    case 'CRASHED':
      return { at: round.crashedAt + s.config.crashedPhaseMs, due: 'openRound' };
    default:
      return assertNever(round);
  }
}

/**
 * The public round, as `hello.round` carries it. Exactly the fields true in the phase — so before
 * the crash there is no seed and no crash point in it to leak.
 */
export function roundSnapshotOf(s: EngineState): RoundSnapshot | null {
  const round = s.round;
  if (round === null) return null;
  const bets = [...round.bets.values()]
    .filter((bet) => bet.status !== 'CANCELLED')
    .map((bet) => ({
      betId: bet.betId,
      nick: bet.nick,
      amount: bet.amount,
      cashedOutAt: bet.status === 'CASHED_OUT' ? bet.multiplier : null,
    }));
  const common = { roundId: round.roundId, chainIndex: round.link?.chainIndex ?? null, bets };
  switch (round.phase) {
    case 'BETTING':
      return { ...common, phase: 'BETTING', bettingClosesAt: round.bettingClosesAt };
    case 'RUNNING':
      return { ...common, phase: 'RUNNING', startedAt: round.startedAt };
    case 'CRASHED':
      return {
        ...common,
        phase: 'CRASHED',
        startedAt: round.startedAt,
        crashedAt: round.crashedAt,
        crashPoint: round.crashPoint,
        fair: revealOf(round),
      };
    default:
      return assertNever(round);
  }
}

/** A reconnecting player's own bets in the current round (`hello.myBets`, §2.10). */
export function myBetsOf(s: EngineState, playerId: PlayerId): MyBet[] {
  const round = s.round;
  if (round === null) return [];
  const mine: MyBet[] = [];
  for (const bet of round.bets.values()) {
    if (bet.playerId !== playerId) continue;
    const fields = { roundId: round.roundId, betId: bet.betId, amount: bet.amount };
    switch (bet.status) {
      case 'OPEN':
        mine.push({ ...fields, status: 'OPEN', autoCashOutAt: bet.autoCashOutAt });
        break;
      case 'CASHED_OUT':
        mine.push({
          ...fields,
          status: 'CASHED_OUT',
          reason: bet.reason,
          multiplier: bet.multiplier,
          payout: bet.payout,
        });
        break;
      case 'LOST':
        mine.push({ ...fields, status: 'LOST' });
        break;
      case 'CANCELLED':
        break;
      default:
        assertNever(bet);
    }
  }
  return mine;
}

/**
 * The drift-correcting tick for `now` (§2.6), or `null` outside the running part of a round. The
 * caller advances before it ticks; a tick is never computed past the crash moment, so it cannot
 * show a multiplier the round did not reach.
 */
export function tickAt(s: EngineState, now: number): ServerMessageOf<'tick'> | null {
  const round = s.round;
  if (round?.phase !== 'RUNNING' || now < round.startedAt || now >= round.crashAt) return null;
  const elapsedMs = now - round.startedAt;
  return {
    type: 'tick',
    roundId: round.roundId,
    elapsedMs,
    multiplier: multiplierAt(s.curve, elapsedMs),
  };
}

/**
 * The conservation law: every minor unit ever granted is in a balance, in a stake still riding, or
 * with the house. `accounted === granted` after every step, or money was created or destroyed.
 */
export function auditMoney(s: EngineState): { readonly granted: Minor; readonly accounted: Minor } {
  let accounted = s.house;
  for (const player of s.players.values()) accounted = add(accounted, player.balance);
  for (const bet of s.round?.bets.values() ?? []) {
    if (bet.status === 'OPEN') accounted = add(accounted, bet.amount);
  }
  return { granted: s.granted, accounted };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

function findBet(s: EngineState, betId: string): { bet: Bet; roundId: string } | undefined {
  const current = s.round?.bets.get(betId);
  if (current !== undefined && s.round !== null) return { bet: current, roundId: s.round.roundId };
  const previous = s.previous?.bets.get(betId);
  if (previous !== undefined && s.previous !== null)
    return { bet: previous, roundId: s.previous.roundId };
  return undefined;
}

function currentBet(s: EngineState, betId: string): Bet | undefined {
  return s.round?.bets.get(betId);
}

function withBet(s: EngineState, bet: Bet): EngineState {
  const round = s.round;
  if (round === null) throw new EngineError('no round to hold a bet'); // unreachable
  return { ...s, round: { ...round, bets: new Map(round.bets).set(bet.betId, bet) } };
}

function withPlayer(s: EngineState, player: Player): EngineState {
  return { ...s, players: new Map(s.players).set(player.id, player) };
}

function baseOf(bet: Bet) {
  return {
    betId: bet.betId,
    playerId: bet.playerId,
    nick: bet.nick,
    amount: bet.amount,
    autoCashOutAt: bet.autoCashOutAt,
    acceptedBalance: bet.acceptedBalance,
  };
}

/** What `crash.fair` carries: the link, now public — or `null` for a forced round (D13). */
function revealOf(round: CrashedRound): ChainLink | null {
  return round.link;
}

function acceptedOf(roundId: string, bet: Bet): ServerMessage {
  return {
    type: 'betAccepted',
    roundId,
    betId: bet.betId,
    amount: bet.amount,
    autoCashOutAt: bet.autoCashOutAt,
    balance: bet.acceptedBalance,
  };
}

function cancelledOf(roundId: string, betId: string, balance: Minor): ServerMessage {
  return { type: 'betCancelled', roundId, betId, balance };
}

function cashOutResultOf(
  roundId: string,
  bet: Extract<Bet, { status: 'CASHED_OUT' }>,
): ServerMessage {
  return {
    type: 'cashOutResult',
    roundId,
    betId: bet.betId,
    reason: bet.reason,
    multiplier: bet.multiplier,
    payout: bet.payout,
    balance: bet.cashOutBalance,
  };
}

function reject(
  s: EngineState,
  playerId: PlayerId,
  code: ErrorCode,
  message: string,
  ids: { readonly roundId?: string; readonly betId: string },
  out: Effect[],
): EngineState {
  out.push(send(playerId, errorMessageOf(code, message, ids)));
  return s;
}

/** A player the engine does not know — the caller let an unauthenticated session through. */
function internal(s: EngineState, playerId: PlayerId, out: Effect[]): EngineState {
  out.push(send(playerId, errorMessageOf('INTERNAL', 'unknown player', {})));
  return s;
}

function broadcast(message: ServerMessage): Effect {
  return { kind: 'broadcast', message };
}

function send(playerId: PlayerId, message: ServerMessage): Effect {
  return { kind: 'send', playerId, message };
}

function assertNever(value: never): never {
  throw new EngineError(`unexpected value: ${JSON.stringify(value)}`);
}
