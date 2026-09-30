import { minor } from '@crash/money';
import type { GameConfig } from '@crash/protocol';
import { z } from 'zod';

/**
 * The server's configuration, read once from the environment.
 *
 * **The boot contract:** a production server refuses every development convenience, and names all
 * of the violations at once rather than one per restart. A demo that boots with a known chain seed
 * or an in-memory database is a demo whose fairness claim and whose balances are fiction.
 */
export interface ServerConfig {
  readonly env: 'development' | 'production';
  readonly host: string;
  readonly port: number;
  /** A file path, or `:memory:` (development and tests only). */
  readonly database: string;
  /** `devFaults` / `devDisconnect` (docs/protocol.md §9) — sender's own connection only. */
  readonly faults: boolean;
  readonly game: GameConfig;
  readonly chain: {
    readonly length: number;
    /** Publish the next chain when this many rounds remain (docs/protocol.md §3.3). */
    readonly rotateAt: number;
    readonly saltPrefix: string;
    /** Development only: a fixed `s₀`, so a dev server's rounds are reproducible. */
    readonly devSeed: string | null;
  };
  /** What a new player's wallet starts with — play money. */
  readonly startingBalance: number;
  readonly logLevel: string;
}

/** The demo's game (docs/protocol.md §2.2). */
export const DEFAULT_GAME: GameConfig = {
  curve: { growthRatePerSecond: 0.15 },
  bettingPhaseMs: 7000,
  crashedPhaseMs: 3000,
  tickIntervalMs: 100,
  minBet: minor(100),
  maxBet: minor(50_000),
  maxAutoCashOut: 100_000,
  houseEdgeBps: 100,
};

const int = (fallback: number) => z.coerce.number().int().default(fallback);

const env = z.object({
  CRASH_ENV: z.enum(['development', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(8080),
  CRASH_DB: z.string().optional(),
  CRASH_FAULTS: z.enum(['on', 'off']).optional(),
  CRASH_CHAIN_LENGTH: int(1_000_000),
  CRASH_CHAIN_ROTATE_AT: int(50_000),
  CRASH_CHAIN_SALT_PREFIX: z.string().min(1).default('crash-demo-chain-'),
  CRASH_DEV_CHAIN_SEED: z.string().optional(),
  CRASH_STARTING_BALANCE: int(100_000),
  CRASH_GROWTH_RATE: z.coerce.number().positive().default(DEFAULT_GAME.curve.growthRatePerSecond),
  CRASH_BETTING_MS: int(DEFAULT_GAME.bettingPhaseMs),
  CRASH_CRASHED_MS: int(DEFAULT_GAME.crashedPhaseMs),
  LOG_LEVEL: z.string().default('info'),
});

export class BootError extends Error {
  override readonly name = 'BootError';
  constructor(readonly violations: readonly string[]) {
    super(`refusing to boot:\n  - ${violations.join('\n  - ')}`);
  }
}

export function readConfig(source: Record<string, string | undefined>): ServerConfig {
  const parsed = env.safeParse(source);
  if (!parsed.success) {
    throw new BootError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const production = e.CRASH_ENV === 'production';
  const violations: string[] = [];

  if (production && e.CRASH_DB === undefined) violations.push('CRASH_DB must name a database file');
  if (production && e.CRASH_DB === ':memory:') {
    violations.push('CRASH_DB=:memory: loses every balance and the chain cursor on restart');
  }
  if (production && e.CRASH_DEV_CHAIN_SEED !== undefined) {
    violations.push('CRASH_DEV_CHAIN_SEED makes every crash point knowable in advance');
  }
  if (e.CRASH_DEV_CHAIN_SEED !== undefined && !/^[0-9a-f]{64}$/.test(e.CRASH_DEV_CHAIN_SEED)) {
    violations.push('CRASH_DEV_CHAIN_SEED must be 64 lowercase hex characters');
  }
  if (e.CRASH_CHAIN_LENGTH < 2) violations.push('CRASH_CHAIN_LENGTH must be at least 2');
  if (e.CRASH_CHAIN_ROTATE_AT < 1 || e.CRASH_CHAIN_ROTATE_AT >= e.CRASH_CHAIN_LENGTH) {
    violations.push('CRASH_CHAIN_ROTATE_AT must be between 1 and CRASH_CHAIN_LENGTH − 1');
  }
  if (violations.length > 0) throw new BootError(violations);

  return {
    env: e.CRASH_ENV,
    host: e.HOST,
    port: e.PORT,
    database: e.CRASH_DB ?? ':memory:',
    faults: (e.CRASH_FAULTS ?? (production ? 'off' : 'on')) === 'on',
    game: {
      ...DEFAULT_GAME,
      curve: { growthRatePerSecond: e.CRASH_GROWTH_RATE },
      bettingPhaseMs: e.CRASH_BETTING_MS,
      crashedPhaseMs: e.CRASH_CRASHED_MS,
    },
    chain: {
      length: e.CRASH_CHAIN_LENGTH,
      rotateAt: e.CRASH_CHAIN_ROTATE_AT,
      saltPrefix: e.CRASH_CHAIN_SALT_PREFIX,
      devSeed: e.CRASH_DEV_CHAIN_SEED ?? null,
    },
    startingBalance: e.CRASH_STARTING_BALANCE,
    logLevel: e.LOG_LEVEL,
  };
}
