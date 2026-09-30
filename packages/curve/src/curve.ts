/** `1.00×` — where every round starts, and where an instant bust stays. */
export const MIN_MULTIPLIER = 100;

/**
 * `1,000,000.00×` — the ceiling on every multiplier, so each one and each payout stays a safe integer
 * (docs/protocol.md §3.2, D10). `@crash/fair` clamps crash points to the same number; the root
 * suite asserts the two agree, since neither package may import the other.
 */
export const MAX_MULTIPLIER = 100_000_000;

/** The curve's one parameter, as `hello.config.curve` carries it. Never hardcoded in a client. */
export interface Curve {
  readonly growthRatePerSecond: number;
}

/** Validates a curve once, so the hot functions below need not. */
export function curve(growthRatePerSecond: number): Curve {
  if (!Number.isFinite(growthRatePerSecond) || growthRatePerSecond <= 0) {
    throw new RangeError(`growthRatePerSecond must be a positive number: ${growthRatePerSecond}`);
  }
  return { growthRatePerSecond };
}

/**
 * `m(ms) = min(MAX, max(100, floor(100 · e^(k · ms / 1000))))` — the multiplier the round shows
 * `elapsedMs` after it started. Before the start (a negative elapsed time, which a client with a
 * little clock skew will ask for) it is `1.00×`.
 *
 * The client may pass fractional milliseconds from its frame clock; the server passes integers.
 * Both get the same floor of the same exponential, so both read the same number.
 */
export function multiplierAt(c: Curve, elapsedMs: number): number {
  if (Number.isNaN(elapsedMs)) throw new RangeError('elapsedMs is NaN');
  if (elapsedMs <= 0) return MIN_MULTIPLIER;
  const value = Math.floor(100 * Math.exp((c.growthRatePerSecond * elapsedMs) / 1000));
  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, value));
}

/**
 * The inverse: the least integer millisecond at which `multiplierAt` reads at least `multiplier`.
 *
 * Defined by the forward function rather than by `ln` alone (docs/protocol.md D9). The logarithm
 * gives an estimate a millisecond or so either side; the two loops walk it to the exact boundary,
 * so `multiplierAt(elapsedAt(x)) ≥ x` and `multiplierAt(elapsedAt(x) − 1) < x` hold for every `x`.
 * This is the moment the server busts at `t(crashPoint)`, and the moment an auto cash-out fires.
 */
export function elapsedAt(c: Curve, multiplier: number): number {
  if (!Number.isInteger(multiplier) || multiplier < MIN_MULTIPLIER || multiplier > MAX_MULTIPLIER) {
    throw new RangeError(
      `not a multiplier in hundredths from ${MIN_MULTIPLIER} to ${MAX_MULTIPLIER}: ${multiplier}`,
    );
  }
  let ms = Math.max(0, Math.ceil((1000 * Math.log(multiplier / 100)) / c.growthRatePerSecond));
  while (multiplierAt(c, ms) < multiplier) ms += 1;
  while (ms > 0 && multiplierAt(c, ms - 1) >= multiplier) ms -= 1;
  return ms;
}

/**
 * The unfloored curve, `100 · e^(k · ms / 1000)` capped at `MAX` — **for drawing only**. A curve
 * plotted from the floored value is a staircase when zoomed in; the line on screen uses this, and
 * the number on screen uses `multiplierAt`. Nothing that pays or decides may read it.
 */
export function smoothMultiplierAt(c: Curve, elapsedMs: number): number {
  if (Number.isNaN(elapsedMs)) throw new RangeError('elapsedMs is NaN');
  if (elapsedMs <= 0) return MIN_MULTIPLIER;
  return Math.min(MAX_MULTIPLIER, 100 * Math.exp((c.growthRatePerSecond * elapsedMs) / 1000));
}
