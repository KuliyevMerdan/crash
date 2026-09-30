/**
 * The chart's axes as pure functions of the round — no state, so no jump.
 *
 * The exponential leaves any fixed viewport within seconds (CLAUDE.md § Gaps, "past ~20×"). The
 * answer here: both extents are **continuous functions of elapsed time and the multiplier**, so
 * consecutive frames can only differ by what one frame of the round moved. A smooth maximum joins
 * the resting extent (8 s × 2.00×) to the growing one without a kink, and because `e^(kt)` rescaled
 * this way is self-similar, the curve keeps the same shape all the way up — the rise reads in the
 * axis labels, not in the line flattening out. A new round starts back at rest; that is the one
 * discontinuity, and it happens behind the "next round" screen.
 */

export interface Extents {
  /** Right edge of the time axis, in seconds. */
  readonly xMaxS: number;
  /** Top of the multiplier axis, as a plain multiple (2 = 2.00×). The bottom is always 1×. */
  readonly yMax: number;
}

const REST_X_S = 8;
const REST_Y = 2;

/** max(a, b), smoothed over a width of `w` — continuous with a continuous derivative. */
function smoothMax(a: number, b: number, w: number): number {
  return (a + b + Math.sqrt((a - b) * (a - b) + w * w)) / 2;
}

export function extents(elapsedS: number, multiple: number): Extents {
  const t = Math.max(0, elapsedS);
  return {
    xMaxS: smoothMax(REST_X_S, t * 1.15 + 1, 1),
    yMax: smoothMax(REST_Y, multiple * 1.18 + 0.1, 0.4),
  };
}

/** Grid steps for a multiplier axis from 1× to `max`: a nice step giving at most `lines` lines. */
export function multiplierTicks(max: number, lines = 5): number[] {
  const step = niceStep((max - 1) / lines);
  const ticks: number[] = [];
  // On multiples of the step — 2×, 4×, 6×, not 3×, 5×, 7× — skipping the 1× baseline itself.
  for (let v = Math.floor(1 / step + 1) * step; v < max; v += step) ticks.push(roundTo(v, step));
  return ticks;
}

/** Grid steps for a time axis from 0 to `maxS` seconds. */
export function timeTicks(maxS: number, lines = 6): number[] {
  const step = niceStep(maxS / lines);
  const ticks: number[] = [];
  for (let v = step; v < maxS; v += step) ticks.push(roundTo(v, step));
  return ticks;
}

function niceStep(raw: number): number {
  const exponent = Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const base = 10 ** exponent;
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= raw) return m * base;
  return 10 * base;
}

/** `v` to as many decimals as the step itself has — 0.25 → 2, 2.5 → 1, 25 → 0. */
function roundTo(v: number, step: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number(v.toFixed(decimals));
}

/**
 * A multiplier as the counter shows it: hundredths, as on the wire (`247` → `2.47×`). Integer
 * arithmetic, so the screen can never show a number the server would disagree with.
 */
export function formatMultiplier(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const frac = hundredths % 100;
  return `${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')}×`;
}

/** An axis label: `1.5×`, `2×`, `20×` — as few digits as the step needs. */
export function formatTick(multiple: number): string {
  return `${Number(multiple.toFixed(2))}×`;
}
