import { performance } from 'node:perf_hooks';

/**
 * The server's clock and timers, injected so tests can drive them.
 *
 * `now()` is epoch milliseconds — the wire's unit (docs/protocol.md §1) — taken from the monotonic
 * clock rather than `Date.now()`, which an NTP correction can move backwards. The engine refuses
 * time that runs backwards (ADR-0002), so the server must not feed it any.
 */
export interface Clock {
  now(): number;
}

/** A timer that can be called off. */
export interface Timer {
  cancel(): void;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): Timer;
  setInterval(fn: () => void, ms: number): Timer;
}

export const systemClock: Clock = {
  now: () => Math.floor(performance.timeOrigin + performance.now()),
};

export const systemScheduler: Scheduler = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    return { cancel: () => clearInterval(handle) };
  },
};
