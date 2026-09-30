import { minor } from '@crash/money';
import { z } from 'zod';

/**
 * The value types every message is built from (docs/protocol.md §2). Each one is the single
 * definition of what that kind of value may be on the wire.
 */

/**
 * `1,000,000.00×` — the ceiling on every multiplier (docs/protocol.md §3.2, D10). Also defined by
 * `@crash/curve` and `@crash/fair`, which this package may not import; `tests/constants.test.ts`
 * asserts all three agree.
 */
export const MAX_MULTIPLIER = 100_000_000;

/** ULID: 26 characters of Crockford base32 — `roundId`, `betId`. */
export const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'not a ULID');

/** A seed or a hash: 64 lowercase hex characters, no prefix (D12). */
export const hash = z.string().regex(/^[0-9a-f]{64}$/, 'not 64 lowercase hex characters');

/** Server epoch milliseconds — or, in `ping`/`pong` only, the client's own clock echoed back. */
export const timestamp = z.int().min(0);

/** A multiplier in hundredths of 1×: `100` is `1.00×` (§2.3). */
export const multiplier = z.int().min(100).max(MAX_MULTIPLIER);

/** An auto cash-out target: above `1.00×`, at most the ceiling; `config.maxAutoCashOut` is the server's. */
export const autoCashOutAt = z.int().min(101).max(MAX_MULTIPLIER);

/** A balance or a payout: minor units, never negative. Parses into the `Minor` brand. */
export const balance = z.int().min(0).transform(minor);

/** A stake: minor units, at least one. */
export const stake = z.int().min(1).transform(minor);

/** A display name: 1–16 characters after trimming (§2.1). */
export const nick = z.string().trim().min(1).max(16);

export const chainIndex = z.int().min(1);
export const chainId = z.int().min(1);
