import { curve } from '@crash/curve';
import type { Bet, EngineEvent, EngineState, Round } from '@crash/engine';
import { minor } from '@crash/money';
import type { GameConfig } from '@crash/protocol';
import { z } from 'zod';

/**
 * The engine's state and events as JSON, for the checkpoint and the journal (`store/store.ts`).
 *
 * Decoding is a parser boundary like any other: what comes back off the disk is checked field by
 * field, and money is re-branded through `minor()`. A checkpoint that does not parse is a server
 * that refuses to boot, not one that plays on from a corrupted balance.
 */

const money = z.int().transform(minor);
const nullableInt = z.int().nullable();

const link = z
  .object({ chainId: z.int(), chainIndex: z.int(), seed: z.string(), previousHash: z.string() })
  .nullable();

const betBase = {
  betId: z.string(),
  playerId: z.string(),
  nick: z.string(),
  amount: money,
  autoCashOutAt: nullableInt,
  acceptedBalance: money,
};

const bet = z.discriminatedUnion('status', [
  z.object({ ...betBase, status: z.literal('OPEN') }),
  z.object({ ...betBase, status: z.literal('CANCELLED'), cancelledBalance: money }),
  z.object({
    ...betBase,
    status: z.literal('CASHED_OUT'),
    reason: z.enum(['MANUAL', 'AUTO']),
    multiplier: z.int(),
    payout: money,
    cashOutBalance: money,
    cashedOutAt: z.int(),
  }),
  z.object({ ...betBase, status: z.literal('LOST') }),
]);

const roundBase = {
  roundId: z.string(),
  link,
  crashPoint: z.int(),
  bettingClosesAt: z.int(),
  bets: z.array(bet),
};

const round = z.discriminatedUnion('phase', [
  z.object({ ...roundBase, phase: z.literal('BETTING') }),
  z.object({
    ...roundBase,
    phase: z.literal('RUNNING'),
    startedAt: z.int(),
    crashAt: z.int(),
    autos: z.array(z.object({ betId: z.string(), fireAt: z.int() })),
  }),
  z.object({ ...roundBase, phase: z.literal('CRASHED'), startedAt: z.int(), crashedAt: z.int() }),
]);

const snapshot = z.object({
  version: z.literal(1),
  players: z.array(z.object({ id: z.string(), nick: z.string(), balance: money })),
  round: round.nullable(),
  previous: round.nullable(),
  // `link` arrived in C3 (D16). A checkpoint written before it loads with `null` — those rounds
  // stay verifiable through `GET /fair/…`; the strip just cannot point at them.
  history: z.array(
    z.object({
      roundId: z.string(),
      crashPoint: z.int(),
      link: z.object({ chainId: z.int(), chainIndex: z.int() }).nullable().default(null),
    }),
  ),
  granted: money,
  house: money,
  now: z.int(),
});

const event = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('addPlayer'),
    playerId: z.string(),
    nick: z.string(),
    balance: money,
  }),
  z.object({ type: z.literal('renamePlayer'), playerId: z.string(), nick: z.string() }),
  z.object({
    type: z.literal('openRound'),
    roundId: z.string(),
    source: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('chain'),
        chain: z.object({ id: z.int(), salt: z.string() }),
        chainIndex: z.int(),
        seed: z.string(),
        previousHash: z.string(),
      }),
      z.object({ kind: z.literal('forced'), crashPoint: z.int() }),
    ]),
  }),
  z.object({
    type: z.literal('placeBet'),
    playerId: z.string(),
    betId: z.string(),
    roundId: z.string(),
    amount: money,
    autoCashOutAt: nullableInt,
  }),
  z.object({ type: z.literal('cancelBet'), playerId: z.string(), betId: z.string() }),
  z.object({ type: z.literal('cashOut'), playerId: z.string(), betId: z.string() }),
  z.object({ type: z.literal('advance') }),
]);

type RoundJson = z.infer<typeof round>;

/** Written for `JSON.stringify` only; `decodeState` is where the shape is checked. */
function roundToJson(r: Round): object {
  return { ...r, bets: [...r.bets.values()] };
}

function roundFromJson(r: RoundJson): Round {
  return { ...r, bets: new Map(r.bets.map((b): [string, Bet] => [b.betId, b])) };
}

export function encodeState(state: EngineState): string {
  return JSON.stringify({
    version: 1,
    players: [...state.players.values()],
    round: state.round === null ? null : roundToJson(state.round),
    previous: state.previous === null ? null : roundToJson(state.previous),
    history: state.history,
    granted: state.granted,
    house: state.house,
    now: state.now,
  });
}

/**
 * The config is the running server's, not the checkpoint's: it is configuration, not state. A round
 * already running keeps the crash moment and auto cash-out schedule it computed at start.
 */
export function decodeState(json: string, config: GameConfig): EngineState {
  const s = snapshot.parse(JSON.parse(json));
  const previous = s.previous === null ? null : roundFromJson(s.previous);
  if (previous !== null && previous.phase !== 'CRASHED') {
    throw new Error('checkpoint: the previous round is not crashed');
  }
  return {
    config,
    curve: curve(config.curve.growthRatePerSecond),
    players: new Map(s.players.map((p) => [p.id, p])),
    round: s.round === null ? null : roundFromJson(s.round),
    previous,
    history: s.history,
    granted: s.granted,
    house: s.house,
    now: s.now,
  };
}

export function encodeEvent(e: EngineEvent): string {
  return JSON.stringify(e);
}

export function decodeEvent(json: string): EngineEvent {
  return event.parse(JSON.parse(json));
}
