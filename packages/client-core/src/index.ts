/**
 * @crash/client-core — the socket client, clock sync, reconnect, and a typed event stream out.
 * **No DOM**: the browser's socket, clock and timers arrive through `ports.ts`, which is what lets
 * the root suite run this very client against the real server in virtual time.
 */
export {
  CrashClient,
  type ClientOptions,
  type ClientState,
  type ClientEvent,
  type ConnectionStatus,
  type Listener,
  type Outcome,
} from './client.js';
export { reduce, viewFromHello, HISTORY_LENGTH, type GameView } from './view.js';
export { ClockSync } from './clock-sync.js';
export { ulid } from './ids.js';
export type { Transport, TransportHandlers, Connection, Clock, Scheduler, Timer } from './ports.js';
