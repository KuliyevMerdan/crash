/**
 * Clock sync (docs/protocol.md §8, D18): each `ping`/`pong` is a sample,
 * `offset = serverTime − (sent + received) / 2` and `rtt = received − sent`, over the last five.
 *
 * - **The offset is the fastest sample's.** A sample that sat behind a resend in one direction is
 *   off by half that wait — and on a lossy link that is most samples, so a median of five lands on
 *   one (P0 measured a client 400 ms behind the server at 20% loss). The exchange with the least
 *   round trip waited least, and its error is bounded by half its own rtt: NTP's choice.
 * - **The rtt is the median.** It prices a press (ADR-0002) — the typical trip, not the luckiest.
 *
 * What no estimate can remove is asymmetry: with uplink `u` and downlink `d` every sample is off by
 * `(u − d) / 2`. Neither number is ever sent back or used for money — `offset` places `startedAt`
 * on this clock, `rtt` tells the player what their press will land on.
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
    let fastest: { offset: number; rtt: number } | null = null;
    for (const s of this.samples) if (fastest === null || s.rtt < fastest.rtt) fastest = s;
    return fastest?.offset ?? null;
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
