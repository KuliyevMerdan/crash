/**
 * @crash/sim — millions of rounds through `engine` and `fair`: the crash distribution, the realised
 * house edge, and flat strategies side by side (ROADMAP S4). `pnpm sim -- --rounds 1000000`.
 */
import { minor } from '@crash/money';
import type { SimOptions } from './sim.js';

export {
  simulate,
  THRESHOLDS,
  type SimOptions,
  type SimReport,
  type StrategyResult,
  type Rate,
} from './sim.js';
export { formatReport } from './format.js';

/** The run the README quotes: the demo's config, a fixed chain, five flat strategies. */
export const DEFAULT_OPTIONS: Omit<SimOptions, 'rounds'> = {
  s0: '5157c0ffee5157c0ffee5157c0ffee5157c0ffee5157c0ffee5157c0ffee5157',
  salt: 'crash-sim-chain',
  config: {
    curve: { growthRatePerSecond: 0.15 },
    bettingPhaseMs: 7000,
    crashedPhaseMs: 3000,
    tickIntervalMs: 100,
    minBet: minor(100),
    maxBet: minor(50_000),
    maxAutoCashOut: 100_000,
    houseEdgeBps: 100,
  },
  // 1.01× is the canary for D14: it ties the crash point about one round in a hundred.
  targets: [101, 150, 200, 1_000, 10_000],
  stake: 100,
};
