declare const brand: unique symbol;

/**
 * An amount in minor units — cents of play money. A safe integer, possibly negative (a delta).
 *
 * The brand is what stops a multiplier, a timestamp or a count of rounds from being added to a
 * balance: all three are `number`, and only this one is money.
 */
export type Minor = number & { readonly [brand]: 'Minor' };

export function isMinor(value: number): value is Minor {
  return Number.isSafeInteger(value);
}

/** The one way into the brand: a safe integer, or a throw naming what it was handed. */
export function minor(value: number): Minor {
  if (!isMinor(value)) throw new RangeError(`not an amount of minor units: ${value}`);
  return value;
}

export const ZERO: Minor = minor(0);

export function add(a: Minor, b: Minor): Minor {
  return minor(a + b);
}

export function sub(a: Minor, b: Minor): Minor {
  return minor(a - b);
}

export function compare(a: Minor, b: Minor): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What a stake returns at a multiplier: `floor(stake × multiplier / 100)`, with the multiplier in
 * hundredths of 1× as it travels on the wire (docs/protocol.md §2.5). Floored, never rounded — the
 * house keeps the fraction of a minor unit, and it keeps it the same way on every runtime.
 *
 * The product is checked before it is divided: past `Number.MAX_SAFE_INTEGER` it is no longer an
 * exact integer, and a payout computed from an inexact one is a wrong payout.
 */
export function payout(stake: Minor, multiplier: number): Minor {
  if (stake < 0) throw new RangeError(`a stake cannot be negative: ${stake}`);
  if (!Number.isSafeInteger(multiplier) || multiplier < 0) {
    throw new RangeError(`not a multiplier in hundredths: ${multiplier}`);
  }
  const product = stake * multiplier;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`payout overflows: ${stake} × ${multiplier}`);
  }
  return minor(Math.floor(product / 100));
}
