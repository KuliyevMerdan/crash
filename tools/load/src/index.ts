/**
 * @crash/load — ROADMAP P0: a crowd of real `client-core` players, the faults a real crowd
 * suffers, and the server's own account to hold them to. `tests/soak.test.ts` runs it in virtual
 * time against the real game server; `pnpm load` runs it over real sockets against a server process.
 */
export {
  Population,
  PROFILE_FAULTS,
  canonical,
  type Bot,
  type Link,
  type PopulationOptions,
  type Profile,
  type SampleKind,
  type Tally,
  type Truth,
} from './population.js';
export { percentile, summarize, formatSummary, type Summary } from './stats.js';
