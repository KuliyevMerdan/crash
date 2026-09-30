import {
  auditMoney,
  createEngine,
  nextDeadline,
  step,
  type EngineEvent,
  type EngineState,
} from '@crash/engine';
import { chainRounds } from '@crash/fair';
import { minor } from '@crash/money';
import type { GameConfig } from '@crash/protocol';

/**
 * N rounds through the code that serves the demo — `fair` draws each crash point from a real chain,
 * the `engine` plays each round with one flat-strategy player per target — with no server, no
 * socket and no clock but the engine's own deadlines. What it reports is what the game pays, not
 * what the formula promises; the formula (docs/protocol.md §3.2) is the column it is checked against.
 */
export interface SimOptions {
  readonly rounds: number;
  /** The chain's `s₀` — fixed, so a run is reproducible and its numbers can be quoted. */
  readonly s0: string;
  readonly salt: string;
  readonly config: GameConfig;
  /** Auto cash-out targets, in hundredths — one player per target, betting every round. */
  readonly targets: readonly number[];
  readonly stake: number;
}

/** An observed rate beside the one the formula predicts, with the binomial standard error. */
export interface Rate {
  readonly observed: number;
  readonly expected: number;
  readonly sigma: number;
}

export interface StrategyResult {
  readonly target: number;
  readonly bets: number;
  readonly wins: number;
  readonly staked: number;
  readonly paid: number;
  /** `paid / staked`, against `1 − E`. */
  readonly rtp: Rate;
}

export interface SimReport {
  readonly rounds: number;
  readonly commit: string;
  readonly houseEdgeBps: number;
  /** `P(crash ≥ m)` at each threshold, against `(1 − E) / m`. */
  readonly distribution: ReadonlyArray<{ readonly multiplier: number } & Rate>;
  /** Rounds that crash at 1.00×, against `1 − (1 − E) / 1.01`. */
  readonly instantBusts: Rate;
  readonly median: number;
  readonly p99: number;
  readonly max: number;
  readonly longestBelow2x: number;
  readonly strategies: readonly StrategyResult[];
  /**
   * The engine's house take over everything staked — the realised edge, all strategies pooled —
   * against `E`. Equal stakes, so its σ is the strategies' combined: dominated by the long shots.
   */
  readonly house: { readonly staked: number; readonly take: number; readonly edge: Rate };
  /** Auto cash-outs whose outcome disagreed with "wins iff target ≤ crash point" (D14). Must be 0. */
  readonly ruleViolations: number;
  /** `auditMoney` after the last round: every minor unit granted is accounted for. */
  readonly conserved: boolean;
}

export const THRESHOLDS = [101, 150, 200, 500, 1_000, 10_000, 100_000];

export function simulate(options: SimOptions): SimReport {
  const { rounds, s0, salt, config, targets, stake } = options;
  const edge = config.houseEdgeBps / 10_000;
  const chain = chainRounds(s0, rounds + 1);

  let s: EngineState = createEngine(config);
  const apply = (event: EngineEvent, now: number) => {
    const result = step(s, event, now);
    s = result.state;
    return result.effects;
  };
  const players = targets.map((target, i) => ({ id: `p${i}`, target, bets: 0, wins: 0, paid: 0 }));
  for (const p of players)
    apply({ type: 'addPlayer', playerId: p.id, nick: p.id, balance: minor(stake * rounds) }, 0);

  const crashes = new Int32Array(rounds);
  let ruleViolations = 0;
  let streak = 0;
  let longestBelow2x = 0;
  let r = 0;

  for (const link of chain.rounds()) {
    const roundId = `R${link.chainIndex}`;
    apply(
      { type: 'openRound', roundId, source: { kind: 'chain', chain: { id: 1, salt }, ...link } },
      nextDeadline(s).at,
    );
    for (const p of players) {
      apply(
        {
          type: 'placeBet',
          playerId: p.id,
          betId: `${roundId}-${p.id}`,
          roundId,
          amount: minor(stake),
          autoCashOutAt: p.target,
        },
        s.now,
      );
      p.bets += 1;
    }

    const won = new Set<string>();
    let crashPoint = 0;
    while (s.round?.phase !== 'CRASHED') {
      for (const effect of apply({ type: 'advance' }, nextDeadline(s).at)) {
        const m = effect.message;
        if (m.type === 'cashOutResult' && effect.kind === 'send') {
          const p = players.find((x) => x.id === effect.playerId);
          if (p !== undefined) {
            p.wins += 1;
            p.paid += m.payout;
            won.add(p.id);
          }
        } else if (m.type === 'crash') {
          crashPoint = m.crashPoint;
        }
      }
    }

    for (const p of players) if (won.has(p.id) !== p.target <= crashPoint) ruleViolations += 1;
    crashes[r] = crashPoint;
    streak = crashPoint < 200 ? streak + 1 : 0;
    longestBelow2x = Math.max(longestBelow2x, streak);
    r += 1;
  }

  const sorted = crashes.slice().sort();
  const rate = (hits: number, p: number): Rate => ({
    observed: hits / rounds,
    expected: p,
    sigma: Math.sqrt((p * (1 - p)) / rounds),
  });
  const atLeast = (m: number) => {
    let n = 0;
    for (const c of crashes) if (c >= m) n += 1;
    return n;
  };
  let instant = 0;
  for (const c of crashes) if (c === 100) instant += 1;

  const staked = players.reduce((n, p) => n + p.bets * stake, 0);
  const audit = auditMoney(s);
  const strategies: StrategyResult[] = players.map((p) => {
    const win = ((1 - edge) * 100) / p.target;
    const multiple = p.target / 100;
    return {
      target: p.target,
      bets: p.bets,
      wins: p.wins,
      staked: p.bets * stake,
      paid: p.paid,
      rtp: {
        observed: p.paid / (p.bets * stake),
        expected: 1 - edge,
        sigma: multiple * Math.sqrt((win * (1 - win)) / p.bets),
      },
    };
  });
  return {
    rounds,
    commit: chain.commit,
    houseEdgeBps: config.houseEdgeBps,
    distribution: THRESHOLDS.map((m) => ({
      multiplier: m,
      ...rate(atLeast(m), Math.min(1, ((1 - edge) * 100) / m)),
    })),
    instantBusts: rate(instant, 1 - (1 - edge) / 1.01),
    median: sorted[Math.floor(rounds / 2)] ?? 0,
    p99: sorted[Math.floor(rounds * 0.99)] ?? 0,
    max: sorted[rounds - 1] ?? 0,
    longestBelow2x,
    strategies,
    house: {
      staked,
      take: s.house,
      edge: {
        observed: s.house / staked,
        expected: edge,
        sigma: Math.sqrt(strategies.reduce((n, x) => n + x.rtp.sigma ** 2, 0)) / strategies.length,
      },
    },
    ruleViolations,
    conserved: audit.accounted === audit.granted,
  };
}
