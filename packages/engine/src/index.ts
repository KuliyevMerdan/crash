/**
 * @crash/engine — the round machine: `(state, event, now) → (state, effects)`.
 *
 * Pure (CLAUDE.md § Purity rules): time is the `now` it is handed, randomness is the seed the
 * caller draws from the chain, and it performs no I/O — it returns the messages to send and never
 * sends one. That is what lets `tools/sim` play millions of rounds through the code that serves the
 * demo, and a bug reproduce from a list of events.
 */
export {
  HISTORY_LENGTH,
  EngineError,
  createEngine,
  step,
  nextDeadline,
  roundSnapshotOf,
  myBetsOf,
  tickAt,
  auditMoney,
} from './engine.js';
export type {
  PlayerId,
  Player,
  Bet,
  Round,
  CrashedRound,
  ChainLink,
  AutoCashOut,
  EngineState,
  EngineEvent,
  Effect,
  Step,
} from './types.js';
