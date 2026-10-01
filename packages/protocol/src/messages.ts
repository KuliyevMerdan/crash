import { z } from 'zod';
import { errorMessage } from './errors.js';
import {
  autoCashOutAt,
  balance,
  chainIndex,
  multiplier,
  nick,
  stake,
  timestamp,
  ulid,
} from './primitives.js';
import {
  chainInfo,
  fairReveal,
  gameConfig,
  historyEntry,
  myBet,
  roundSnapshot,
} from './snapshot.js';

// ── c→s ──────────────────────────────────────────────────────────────────────────────────────────

export const authenticate = z.object({
  type: z.literal('authenticate'),
  token: z.string().min(1).nullable(),
  nick,
});

export const ping = z.object({ type: z.literal('ping'), clientTime: timestamp });

export const placeBet = z.object({
  type: z.literal('placeBet'),
  betId: ulid,
  roundId: ulid,
  amount: stake,
  autoCashOutAt: autoCashOutAt.nullable(),
});

export const cancelBet = z.object({ type: z.literal('cancelBet'), betId: ulid });

/** No multiplier, no timestamp: the client has nothing to say the server would believe (ADR-0002). */
export const cashOut = z.object({ type: z.literal('cashOut'), betId: ulid });

export const clientMessage = z.discriminatedUnion('type', [
  authenticate,
  ping,
  placeBet,
  cancelBet,
  cashOut,
]);

// ── s→c ──────────────────────────────────────────────────────────────────────────────────────────

export const hello = z.object({
  type: z.literal('hello'),
  token: z.string().min(1),
  serverTime: timestamp,
  player: z.object({ id: z.string().min(1), nick, balance }),
  config: gameConfig,
  chain: chainInfo,
  round: roundSnapshot,
  myBets: z.array(myBet),
  history: z.array(historyEntry),
});

export const pong = z.object({
  type: z.literal('pong'),
  clientTime: timestamp,
  serverTime: timestamp,
});

export const bettingOpen = z.object({
  type: z.literal('bettingOpen'),
  roundId: ulid,
  chainIndex: chainIndex.nullable(),
  bettingClosesAt: timestamp,
});

export const betAccepted = z.object({
  type: z.literal('betAccepted'),
  roundId: ulid,
  betId: ulid,
  amount: stake,
  autoCashOutAt: autoCashOutAt.nullable(),
  balance,
});

/** `amount` only. `autoCashOutAt` is never broadcast (D4) — and is stripped here if it ever were. */
export const betPlaced = z.object({
  type: z.literal('betPlaced'),
  roundId: ulid,
  betId: ulid,
  nick,
  amount: stake,
});

export const betCancelled = z.object({
  type: z.literal('betCancelled'),
  roundId: ulid,
  betId: ulid,
  balance,
});

export const betWithdrawn = z.object({
  type: z.literal('betWithdrawn'),
  roundId: ulid,
  betId: ulid,
});

export const roundStart = z.object({
  type: z.literal('roundStart'),
  roundId: ulid,
  startedAt: timestamp,
});

export const tick = z.object({
  type: z.literal('tick'),
  roundId: ulid,
  elapsedMs: z.int().min(0),
  multiplier,
});

export const cashOutResult = z.object({
  type: z.literal('cashOutResult'),
  roundId: ulid,
  betId: ulid,
  reason: z.enum(['MANUAL', 'AUTO']),
  multiplier,
  payout: balance,
  balance,
});

/** No payout, no balance: stakes are public, balances are not (§2.5). */
export const playerCashedOut = z.object({
  type: z.literal('playerCashedOut'),
  roundId: ulid,
  betId: ulid,
  nick,
  multiplier,
});

export const crash = z.object({
  type: z.literal('crash'),
  roundId: ulid,
  crashPoint: multiplier,
  crashedAt: timestamp,
  fair: fairReveal.nullable(),
  settled: z.array(z.object({ betId: ulid, nick, won: z.boolean() })),
});

export const serverMessage = z.discriminatedUnion('type', [
  hello,
  pong,
  bettingOpen,
  betAccepted,
  betPlaced,
  betCancelled,
  betWithdrawn,
  roundStart,
  tick,
  cashOutResult,
  playerCashedOut,
  crash,
  errorMessage,
]);

export type ClientMessage = z.infer<typeof clientMessage>;
export type ServerMessage = z.infer<typeof serverMessage>;
export type ClientMessageType = ClientMessage['type'];
export type ServerMessageType = ServerMessage['type'];

/** What a message of type `T` is, for handlers keyed by type. */
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>;
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;

export const CLIENT_MESSAGE_TYPES = [
  'authenticate',
  'ping',
  'placeBet',
  'cancelBet',
  'cashOut',
] as const satisfies readonly ClientMessageType[];

export const SERVER_MESSAGE_TYPES = [
  'hello',
  'pong',
  'bettingOpen',
  'betAccepted',
  'betPlaced',
  'betCancelled',
  'betWithdrawn',
  'roundStart',
  'tick',
  'cashOutResult',
  'playerCashedOut',
  'crash',
  'error',
] as const satisfies readonly ServerMessageType[];

// ── Dev messages (§9) — outside the §2 table; a server decides whether it listens ──────────────

export const devForceCrashPoint = z.object({
  type: z.literal('devForceCrashPoint'),
  crashPoint: multiplier,
});

/**
 * The sender's own link, both ways: a one-way latency, and the share of frames whose packets are
 * lost — which TCP resends, so a lost frame arrives late and in order, never not at all (D17).
 */
export const devFaults = z.object({
  type: z.literal('devFaults'),
  latencyMs: z.int().min(0).max(10_000),
  lossRate: z.number().min(0).max(0.9),
});

/** The sender's link freezes for `ms`, both ways, then delivers everything it held, in order. */
export const devStall = z.object({
  type: z.literal('devStall'),
  ms: z.int().min(1).max(30_000),
});

export const devDisconnect = z.object({ type: z.literal('devDisconnect') });

export const devMessage = z.discriminatedUnion('type', [
  devForceCrashPoint,
  devFaults,
  devStall,
  devDisconnect,
]);

export type DevMessage = z.infer<typeof devMessage>;
export type DevMessageType = DevMessage['type'];

export const DEV_MESSAGE_TYPES = [
  'devForceCrashPoint',
  'devFaults',
  'devStall',
  'devDisconnect',
] as const satisfies readonly DevMessageType[];

// ── HTTP (§3.3) ──────────────────────────────────────────────────────────────────────────────────

export const chainListing = z.object({
  chains: z.array(chainInfo.extend({ houseEdgeBps: z.int().min(0).max(9999) })),
});

export const revealedRound = fairReveal.extend({ crashPoint: multiplier, roundId: ulid });

export type ChainListing = z.infer<typeof chainListing>;
export type RevealedRound = z.infer<typeof revealedRound>;
