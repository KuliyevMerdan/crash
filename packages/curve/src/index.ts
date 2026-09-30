/**
 * @crash/curve — the multiplier as a pure function of round time, and its exact inverse.
 *
 * One implementation, imported by the server to schedule the bust and price a cash-out and by the
 * client to draw at 60 fps (docs/protocol.md §3.1). The moment there are two, they drift, and the
 * drift is a payout bug that only appears under load.
 *
 * Multipliers are integers in hundredths of 1× — `100` is `1.00×` — exactly as they travel on the
 * wire. Time is milliseconds since the round's `startedAt`.
 */
export {
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
  type Curve,
  curve,
  multiplierAt,
  elapsedAt,
  smoothMultiplierAt,
} from './curve.js';
