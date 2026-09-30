/**
 * What the client needs from its environment, as interfaces — this package has no DOM (CLAUDE.md
 * § Packages), so the browser's `WebSocket`, `performance.now` and `setTimeout` arrive through here.
 * `apps/web` passes the real ones; the tests pass a virtual clock and an in-process network.
 */

/** One connection attempt. Handlers fire at most once each for `open` and `close`. */
export interface Transport {
  connect(handlers: TransportHandlers): Connection;
}

export interface TransportHandlers {
  open(): void;
  message(frame: string): void;
  /** The connection is gone — refused, dropped or closed. */
  close(): void;
}

export interface Connection {
  send(frame: string): void;
  close(): void;
}

/** The client's own clock, in epoch milliseconds. It may be hours off the server's; that is §8's job. */
export interface Clock {
  now(): number;
}

export interface Timer {
  cancel(): void;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): Timer;
}
