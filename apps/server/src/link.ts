import type { Clock, Scheduler, Timer } from './time.js';

/** A connection's simulated network (`devFaults`, `devStall` — docs/protocol.md §9, D17). */
export interface Faults {
  /** One-way delay, each direction. */
  readonly latencyMs: number;
  /** The share of frames whose packets are lost and resent. */
  readonly lossRate: number;
}

export const NO_FAULTS: Faults = { latencyMs: 0, lossRate: 0 };

/** TCP's minimum retransmission timeout on Linux; each further loss of the same frame doubles it. */
export const RTO_MS = 200;
const MAX_RETRIES = 6;

/**
 * One direction of a connection, as TCP behaves under loss: **a frame is never lost, only late, and
 * never overtakes the frame before it.** A lost packet is resent after the retransmission timeout
 * (200 ms, doubling), and everything behind it waits — head-of-line blocking, which is what loss on
 * a WebSocket actually looks like from either end. A stall holds the lane shut until it lifts, then
 * delivers what it held in order.
 *
 * With no faults and nothing queued, a frame is delivered synchronously — the production path pays
 * nothing for the simulation existing.
 */
export class Lane {
  /** When the last frame handed to this lane is due; a later frame is never due before it. */
  private tail = 0;
  private stalledUntil = 0;
  /**
   * Frames waiting, oldest first — and so in order of their due moments. One timer drains them.
   * Order is the queue's, never the timers': a real timer fires late when the loop is busy, and a
   * frame due *after* it but handed in *while* it is late must still wait its turn (P0 found the
   * first version, a timer per frame, letting a tick overtake its round's crash).
   */
  private readonly queue: Array<{ readonly at: number; readonly fn: () => void }> = [];
  private draining: Timer | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly random: () => number,
  ) {}

  deliver(faults: Faults, fn: () => void): void {
    const now = this.clock.now();
    let delay = faults.latencyMs;
    for (let retry = 0; retry < MAX_RETRIES && faults.lossRate > 0; retry += 1) {
      if (this.random() >= faults.lossRate) break;
      delay += RTO_MS * 2 ** retry;
    }
    const at = Math.max(now + delay, this.tail, this.stalledUntil);
    this.tail = at;
    if (this.queue.length === 0 && at <= now) {
      fn(); // the production path: nothing queued, nothing to wait for
      return;
    }
    this.queue.push({ at, fn });
    this.arm();
  }

  stall(ms: number): void {
    this.stalledUntil = Math.max(this.stalledUntil, this.clock.now() + ms);
  }

  private arm(): void {
    const head = this.queue[0];
    if (head === undefined || this.draining !== null) return;
    this.draining = this.scheduler.setTimeout(
      () => {
        this.draining = null;
        this.drain();
      },
      Math.max(0, head.at - this.clock.now()),
    );
  }

  private drain(): void {
    const now = this.clock.now();
    for (let head = this.queue[0]; head !== undefined && head.at <= now; head = this.queue[0]) {
      this.queue.shift();
      head.fn();
    }
    this.arm();
  }
}
