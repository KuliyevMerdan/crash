/** Percentiles over a sample, nearest-rank. `NaN` for an empty one — a table should show the gap. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

export interface Summary {
  readonly n: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

export function summarize(values: readonly number[]): Summary {
  let max = Number.NaN;
  for (const v of values) if (!(v <= max)) max = v;
  return { n: values.length, p50: percentile(values, 50), p99: percentile(values, 99), max };
}

/** `p50 / p99 / max (n)` in whole milliseconds, or a dash when there is nothing to say. */
export function formatSummary(s: Summary, unit = 'ms'): string {
  if (s.n === 0) return '—';
  const f = (v: number) => `${Math.round(v)}`;
  return `${f(s.p50)} / ${f(s.p99)} / ${f(s.max)} ${unit} (n = ${s.n.toLocaleString('en')})`;
}
