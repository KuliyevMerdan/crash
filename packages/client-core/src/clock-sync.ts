/**
 * Clock sync (docs/protocol.md §8): each `ping`/`pong` is a sample,
 * `offset = serverTime − (sent + received) / 2` and `rtt = received − sent`, and the client keeps
 * the **median of the last five** of each.
 *
 * The median, not the mean, because one sample that sat behind a retransmit is not information
 * about the clock. What no estimate can remove is asymmetry: if the uplink takes `u` and the
 * downlink `d`, every sample is off by `(u − d) / 2`, and so is the median. Neither number is ever
 * sent back or used for money — `offset` places `startedAt` on this clock, `rtt` tells the player
 * what their press will land on (ADR-0002).
 */
export class ClockSync {
  private readonly samples: Array<{ offset: number; rtt: number }> = [];

  constructor(private readonly window = 5) {}

  add(sent: number, received: number, serverTime: number): void {
    if (received < sent) return; // a clock that stepped backwards mid-sample says nothing useful
    this.samples.push({ offset: serverTime - (sent + received) / 2, rtt: received - sent });
    if (this.samples.length > this.window) this.samples.shift();
  }

  /** Server time minus client time, or `null` before the first sample. */
  get offset(): number | null {
    return median(this.samples.map((s) => s.offset));
  }

  get rtt(): number | null {
    return median(this.samples.map((s) => s.rtt));
  }

  get size(): number {
    return this.samples.length;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? hi) + hi) / 2;
}
