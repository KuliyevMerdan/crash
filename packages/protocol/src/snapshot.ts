import { z } from 'zod';
import {
  autoCashOutAt,
  balance,
  chainId,
  chainIndex,
  hash,
  multiplier,
  nick,
  stake,
  timestamp,
  ulid,
} from './primitives.js';

/** The reveal (§2.7) — in `crash`, in a `CRASHED` snapshot, and from `GET /fair/…`. Never before. */
export const fairReveal = z.object({
  chainId,
  chainIndex,
  seed: hash,
  previousHash: hash,
});

/** A bet as the table sees it (§2.10). No balance, no `autoCashOutAt` (D4). */
export const publicBet = z.object({
  betId: ulid,
  nick,
  amount: stake,
  cashedOutAt: multiplier.nullable(),
});

const myBetFields = { roundId: ulid, betId: ulid, amount: stake };

/** A player's own bet in the current round, as `hello.myBets` restores it (§2.10). */
export const myBet = z.discriminatedUnion('status', [
  z.object({ ...myBetFields, status: z.literal('OPEN'), autoCashOutAt: autoCashOutAt.nullable() }),
  z.object({
    ...myBetFields,
    status: z.literal('CASHED_OUT'),
    reason: z.enum(['MANUAL', 'AUTO']),
    multiplier,
    payout: balance,
  }),
  z.object({ ...myBetFields, status: z.literal('LOST') }),
]);

/** `chainIndex` is `null` only for a forced dev round (§9), which claims no link in the chain. */
const roundFields = { roundId: ulid, chainIndex: chainIndex.nullable(), bets: z.array(publicBet) };

/** The round, one variant per phase, each with exactly the fields true in it (§2.3). */
export const roundSnapshot = z.discriminatedUnion('phase', [
  z.object({ ...roundFields, phase: z.literal('BETTING'), bettingClosesAt: timestamp }),
  z.object({ ...roundFields, phase: z.literal('RUNNING'), startedAt: timestamp }),
  z.object({
    ...roundFields,
    phase: z.literal('CRASHED'),
    startedAt: timestamp,
    crashedAt: timestamp,
    crashPoint: multiplier,
    /** `null` only for a forced dev round: no seed to reveal, and never dressed as verifiable (D13). */
    fair: fairReveal.nullable(),
  }),
]);

/** `hello.config` (§2.2). The client reads every number from here and hardcodes none. */
export const gameConfig = z
  .object({
    curve: z.object({ growthRatePerSecond: z.number().positive().finite() }),
    bettingPhaseMs: z.int().positive(),
    crashedPhaseMs: z.int().positive(),
    tickIntervalMs: z.int().positive(),
    minBet: stake,
    maxBet: stake,
    maxAutoCashOut: autoCashOutAt,
    houseEdgeBps: z.int().min(0).max(9999),
  })
  .refine((config) => config.minBet <= config.maxBet, {
    message: 'minBet must not exceed maxBet',
    path: ['minBet'],
  });

/** A chain's public parameters (§3.3) — `hello.chain`, and each entry of `GET /fair/chains`. */
export const chainInfo = z.object({
  id: chainId,
  commit: hash,
  salt: z.string().min(1),
  length: z.int().min(2),
});

export const historyEntry = z.object({ roundId: ulid, crashPoint: multiplier });

export type FairReveal = z.infer<typeof fairReveal>;
export type PublicBet = z.infer<typeof publicBet>;
export type MyBet = z.infer<typeof myBet>;
export type RoundSnapshot = z.infer<typeof roundSnapshot>;
export type GameConfig = z.infer<typeof gameConfig>;
export type ChainInfo = z.infer<typeof chainInfo>;
export type HistoryEntry = z.infer<typeof historyEntry>;
