import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, formatReport, simulate, type Rate } from './index.js';

/**
 * ROADMAP S4, the CI half: the full run is `pnpm sim` (a million rounds, ~15 s); this pins the same
 * claims at 50,000 rounds, where a regression in `fair` or the engine shows up as a number.
 *
 * Every statistical check is at 4σ of its own binomial error, so it fails for a real shift and not
 * for noise — and the run is seeded, so it fails the same way every time. The one exact check is the
 * D14 rule, which a single tie would break.
 */
const ROUNDS = 50_000;
const report = simulate({ ...DEFAULT_OPTIONS, rounds: ROUNDS });
const within = (r: Rate, k = 4) => Math.abs(r.observed - r.expected) <= k * r.sigma;

describe(`${ROUNDS.toLocaleString('en-US')} rounds through engine + fair`, () => {
  it('conserves money and pays every auto cash-out by the rule: wins iff target ≤ crash point', () => {
    expect(report.conserved).toBe(true);
    expect(report.ruleViolations).toBe(0);
  });

  it.each(DEFAULT_OPTIONS.targets.map((t) => [t]))(
    'returns 1 − E to a flat %d-hundredths strategy, within 4σ',
    (target) => {
      const strategy = report.strategies.find((s) => s.target === target);
      expect(strategy?.bets).toBe(ROUNDS);
      expect(strategy && within(strategy.rtp)).toBe(true);
    },
  );

  it('follows P(crash ≥ m) = (1 − E)/m at every threshold, within 4σ', () => {
    for (const d of report.distribution)
      expect({ m: d.multiplier, ok: within(d) }).toEqual({ m: d.multiplier, ok: true });
  });

  it('busts instantly at 1 − (1 − E)/1.01 — the edge plus the multipliers that floor to 1.00×', () => {
    expect(report.instantBusts.expected).toBeCloseTo(0.0198, 4);
    expect(within(report.instantBusts)).toBe(true);
  });

  it('realises the configured edge, all bets pooled, within 4σ', () => {
    expect(report.house.edge.expected).toBe(0.01);
    expect(within(report.house.edge)).toBe(true);
  });

  it('is reproducible: the same chain gives the same report', () => {
    expect(simulate({ ...DEFAULT_OPTIONS, rounds: 2_000 })).toEqual(
      simulate({ ...DEFAULT_OPTIONS, rounds: 2_000 }),
    );
  });

  it('would catch S2’s tie rule: a 1.01× strategy paid only on crash > target returns ≈98%, >9σ off', () => {
    const strategy = report.strategies.find((s) => s.target === 101);
    if (strategy === undefined) throw new Error('no 1.01× strategy');
    const tieRuleRtp = 0.99 * (101 / 102);
    expect((strategy.rtp.observed - tieRuleRtp) / strategy.rtp.sigma).toBeGreaterThan(9);
  });

  it('prints the tables a README would carry', () => {
    const text = formatReport(report, 1234);
    expect(text).toContain('| always 1.50× |');
    expect(text).toContain('| instant bust (1.00×) |');
    expect(text).toContain('money conserved: yes');
  });
});
