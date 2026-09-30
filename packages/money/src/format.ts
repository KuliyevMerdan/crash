import type { Minor } from './minor.js';

export interface FormatOptions {
  /** BCP 47 locale for grouping and the decimal mark. */
  readonly locale?: string;
  /** How many minor units make one major unit, as a power of ten. Play money uses cents: 2. */
  readonly fractionDigits?: number;
}

/**
 * Display only. The string never goes back into arithmetic — it is the last thing that happens to
 * an amount on its way to a person.
 *
 * The major and minor parts are split in integers first, so `Intl.NumberFormat` is handed a whole
 * number and a separate fraction and never rounds a float of its own making.
 */
export function formatMinor(amount: Minor, options: FormatOptions = {}): string {
  const digits = options.fractionDigits ?? 2;
  if (!Number.isInteger(digits) || digits < 0 || digits > 6) {
    throw new RangeError(`fractionDigits must be an integer from 0 to 6: ${digits}`);
  }
  const unit = 10 ** digits;
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const major = Math.floor(abs / unit);
  const fraction = abs % unit;

  const format = new Intl.NumberFormat(options.locale, { maximumFractionDigits: 0 });
  const whole = format.format(major);
  if (digits === 0) return sign + whole;

  const decimal =
    new Intl.NumberFormat(options.locale).formatToParts(1.5).find((p) => p.type === 'decimal')
      ?.value ?? '.';
  return `${sign}${whole}${decimal}${String(fraction).padStart(digits, '0')}`;
}
