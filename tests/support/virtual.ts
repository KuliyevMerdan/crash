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
  private timers: Array<{ at: number; seq: number; fn: () => void; live: boolean }> = [];

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer = { at: this.now + Math.max(0, Math.floor(ms)), seq: this.seq++, fn, live: true };
    this.timers.push(timer);
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
      let next: (typeof this.timers)[number] | undefined;
      for (const t of this.timers) {
        if (
          t.live &&
          t.at <= until &&
          (next === undefined || t.at < next.at || (t.at === next.at && t.seq < next.seq))
        ) {
          next = t;
        }
      }
      if (next === undefined) break;
      next.live = false;
      this.now = next.at;
      next.fn();
    }
    this.timers = this.timers.filter((t) => t.live);
    this.now = until;
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

  constructor(
    private readonly time: VirtualTime,
    private readonly hub: Hub,
    private readonly latency: { up: number; down: number } = { up: 0, down: 0 },
  ) {}

  connect(handlers: TransportHandlers) {
    this.links += 1;
    let alive = true;
    let attached: Attached | null = null;
    const kill = (notifyClient: boolean) => {
      if (!alive) return;
      alive = false;
      attached?.closed();
      if (notifyClient) handlers.close();
    };
    this.cutCurrent = () => kill(true);

    this.time.setTimeout(() => {
      if (!alive) return;
      attached = this.hub.attach({
        send: (frame) =>
          void this.time.setTimeout(() => {
            if (alive) handlers.message(frame);
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
          if (alive) attached?.receive(frame);
        }, this.latency.up),
      close: () => kill(false),
    };
  }

  /** The network dies under the live connection. */
  cut(): void {
    this.cutCurrent?.();
    this.cutCurrent = null;
  }
}
