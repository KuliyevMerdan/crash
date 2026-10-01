import type { Transport, TransportHandlers } from '@crash/client-core';
import type { Attached, Hub } from '@crash/server';

/**
 * One virtual clock for the server and the client: both schedulers, both clocks. Timers run in
 * order of their due moment when a test advances time, so a hundred rounds with twenty dropped
 * connections take milliseconds and fail — if they fail — the same way every run.
 */
export class VirtualTime {
  now = 1_790_000_000_000;
  private seq = 0;
  /**
   * A binary min-heap on `(at, seq)`. A crowd of a few hundred clients keeps thousands of timers
   * alive — pings, request timeouts, the server's fault lanes — and a linear scan per firing made
   * the P0 soak quadratic; the heap makes each firing logarithmic. A cancelled timer stays in the
   * heap, dead, until it surfaces.
   */
  private heap: Array<{ at: number; seq: number; fn: () => void; live: boolean }> = [];

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer = { at: this.now + Math.max(0, Math.floor(ms)), seq: this.seq++, fn, live: true };
    this.push(timer);
    return { cancel: () => void (timer.live = false) };
  }

  setInterval(fn: () => void, ms: number): { cancel(): void } {
    let current = { cancel() {} };
    let stopped = false;
    const run = () => {
      if (stopped) return;
      fn();
      current = this.setTimeout(run, ms);
    };
    current = this.setTimeout(run, ms);
    return {
      cancel: () => {
        stopped = true;
        current.cancel();
      },
    };
  }

  readonly clock = { now: () => this.now };

  /** Run every timer due up to `now + ms`, in order, advancing the clock to each. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const next = this.heap[0];
      if (next === undefined || next.at > until) break;
      this.pop();
      if (!next.live) continue;
      next.live = false;
      this.now = next.at;
      next.fn();
    }
    this.now = until;
  }

  private before(a: number, b: number): boolean {
    const x = this.heap[a];
    const y = this.heap[b];
    if (x === undefined || y === undefined) return false;
    return x.at < y.at || (x.at === y.at && x.seq < y.seq);
  }

  private swap(a: number, b: number): void {
    const x = this.heap[a];
    const y = this.heap[b];
    if (x === undefined || y === undefined) return;
    this.heap[a] = y;
    this.heap[b] = x;
  }

  private push(timer: (typeof this.heap)[number]): void {
    let i = this.heap.push(timer) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private pop(): void {
    const last = this.heap.pop();
    if (last === undefined || this.heap.length === 0) return;
    this.heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < this.heap.length && this.before(l, smallest)) smallest = l;
      if (r < this.heap.length && this.before(r, smallest)) smallest = r;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }
}

/**
 * An in-process network between `@crash/client-core`'s `Transport` and the server's `Hub`, with a
 * latency each way. `cut()` kills the live link the way a dead network does: both ends hear a
 * close, whatever was in flight is lost.
 */
export class VirtualNet implements Transport {
  links = 0;
  private cutCurrent: (() => void) | null = null;
  private darkCurrent: (() => void) | null = null;

  constructor(
    private readonly time: VirtualTime,
    private readonly hub: Hub,
    private readonly latency: { up: number; down: number } = { up: 0, down: 0 },
  ) {}

  connect(handlers: TransportHandlers) {
    this.links += 1;
    let alive = true;
    let dark = false;
    let attached: Attached | null = null;
    const kill = (notifyClient: boolean) => {
      if (!alive) return;
      alive = false;
      attached?.closed();
      if (notifyClient) handlers.close();
    };
    this.cutCurrent = () => kill(true);
    this.darkCurrent = () => void (dark = true);

    this.time.setTimeout(() => {
      if (!alive) return;
      attached = this.hub.attach({
        send: (frame) =>
          void this.time.setTimeout(() => {
            if (alive && !dark) handlers.message(frame);
          }, this.latency.down),
        terminate: () => kill(true),
        get isOpen() {
          return alive;
        },
      });
      handlers.open();
    }, this.latency.up);

    return {
      send: (frame: string) =>
        void this.time.setTimeout(() => {
          if (alive && !dark) attached?.receive(frame);
        }, this.latency.up),
      close: () => kill(false),
    };
  }

  /** The network dies under the live connection. */
  cut(): void {
    this.cutCurrent?.();
    this.cutCurrent = null;
  }

  /**
   * The network goes dark under the live connection without anyone hearing a close: frames are
   * lost both ways, and both ends keep the socket — a half-open connection.
   */
  blackhole(): void {
    this.darkCurrent?.();
    this.darkCurrent = null;
  }
}

/** A seeded generator, so a run with randomness in it is the same run every time. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
