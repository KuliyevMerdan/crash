import { performance } from 'node:perf_hooks';
import { formatReport } from './format.js';
import { DEFAULT_OPTIONS, simulate } from './index.js';

/** `pnpm sim -- --rounds 1000000 [--seed <64 hex>] [--json]` */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rounds = Number(arg('rounds') ?? 1_000_000);
const s0 = arg('seed') ?? DEFAULT_OPTIONS.s0;
if (!Number.isSafeInteger(rounds) || rounds < 1)
  throw new Error(`--rounds must be a positive integer`);
if (!/^[0-9a-f]{64}$/.test(s0)) throw new Error('--seed must be 64 lowercase hex characters');

const started = performance.now();
const report = simulate({ ...DEFAULT_OPTIONS, rounds, s0 });
const elapsed = performance.now() - started;

process.stdout.write(
  process.argv.includes('--json')
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatReport(report, elapsed)}\n`,
);
if (report.ruleViolations > 0 || !report.conserved) process.exit(1);
