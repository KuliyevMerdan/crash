import { minor, type Minor } from '@crash/money';

/**
 * Typed text to money, and back. The player types major units (`5`, `5.5`, `5.50`); the wire wants
 * minor units, integers. Parsed digit by digit — never through a float — so `0.29` is 29, not
 * 28.999…, and anything with more than two decimals is refused rather than rounded.
 */
export function parseStake(text: string): Minor | null {
  const match = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (match === null) return null;
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? '').padEnd(2, '0'));
  return minor(whole * 100 + frac);
}

/** Minor units as the input shows them: `500` → `5.00`. No grouping — it is an input, not a label. */
export function stakeText(amount: Minor): string {
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

/** A multiplier typed as `2`, `2.5` or `2.50` to hundredths (`250`), the wire's unit. */
export function parseMultiplier(text: string): number | null {
  const match = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*×?\s*$/.exec(text);
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
