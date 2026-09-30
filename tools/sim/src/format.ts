import type { Rate, SimReport } from './sim.js';

const x = (hundredths: number) => `${(hundredths / 100).toFixed(2)}×`;
const pct = (v: number, digits = 3) => `${(v * 100).toFixed(digits)}%`;
const z = (r: Rate) => (r.sigma === 0 ? '—' : ((r.observed - r.expected) / r.sigma).toFixed(2));

/** The report as the Markdown tables a README would carry. */
export function formatReport(report: SimReport, elapsedMs: number): string {
  const lines: string[] = [];
  lines.push(
    `**${report.rounds.toLocaleString('en-US')} rounds** through \`engine\` + \`fair\` · house edge ${report.houseEdgeBps} bps · chain commit \`${report.commit.slice(0, 16)}…\` · ${(elapsedMs / 1000).toFixed(1)} s`,
    '',
    '| Flat strategy (auto cash-out) | Bets | Win rate | RTP | Expected | σ | z |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const s of report.strategies) {
    lines.push(
      `| always ${x(s.target)} | ${s.bets.toLocaleString('en-US')} | ${pct(s.wins / s.bets, 2)} | ${pct(s.rtp.observed)} | ${pct(s.rtp.expected, 1)} | ${pct(s.rtp.sigma)} | ${z(s.rtp)} |`,
    );
  }
  lines.push(
    '',
    `Realised house edge, all bets pooled: **${pct(report.house.edge.observed)}** against ${pct(report.house.edge.expected, 1)} (σ ${pct(report.house.edge.sigma)}, z ${z(report.house.edge)}) — ${report.house.take.toLocaleString('en-US')} of ${report.house.staked.toLocaleString('en-US')} staked.`,
    '',
    '| P(crash ≥ m) | Observed | Expected `(1 − E)/m` | z |',
    '| --- | ---: | ---: | ---: |',
  );
  for (const d of report.distribution) {
    lines.push(`| ${x(d.multiplier)} | ${pct(d.observed)} | ${pct(d.expected)} | ${z(d)} |`);
  }
  lines.push(
    `| instant bust (1.00×) | ${pct(report.instantBusts.observed)} | ${pct(report.instantBusts.expected)} | ${z(report.instantBusts)} |`,
    '',
    `Median crash ${x(report.median)} · p99 ${x(report.p99)} · max ${x(report.max)} · longest run below 2× ${report.longestBelow2x} rounds.`,
    `Auto cash-outs off the D14 rule: ${report.ruleViolations} · money conserved: ${report.conserved ? 'yes' : '**NO**'}.`,
  );
  return lines.join('\n');
}
