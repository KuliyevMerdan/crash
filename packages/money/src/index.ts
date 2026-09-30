/**
 * @crash/money — the branded `Minor`, integer arithmetic, and display.
 *
 * Money is an integer count of minor units on both sides of the wire (docs/protocol.md §1). Every
 * operation here either returns an exact safe integer or throws; none of them rounds silently.
 */
export type { Minor } from './minor.js';
export { isMinor, minor, ZERO, add, sub, payout, compare } from './minor.js';
export { formatMinor, type FormatOptions } from './format.js';
