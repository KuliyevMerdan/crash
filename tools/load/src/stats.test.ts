import { describe, expect, it } from 'vitest';
import { canonical } from './population.js';
import { percentile, summarize } from './stats.js';

describe('stats', () => {
  it('takes nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i); // 100 … 1, unsorted
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  it('summarises, max included', () => {
    expect(summarize([3, 1, 2])).toEqual({ n: 3, p50: 2, p99: 3, max: 3 });
  });
});

describe('canonical', () => {
  it('compares values from two sources whatever order their keys came in', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: null }] })).toBe(
      canonical({ a: [{ c: null, d: 2 }], b: 1 }),
    );
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  });
});
