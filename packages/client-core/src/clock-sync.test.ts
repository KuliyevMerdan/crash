import { describe, expect, it } from 'vitest';
import { ClockSync } from './clock-sync.js';

/** One exchange: sent at `t` on the client, `up` ms to the server, `down` ms back. Truth: +1000. */
function sample(sync: ClockSync, t: number, up: number, down: number): void {
  sync.add(t, t + up + down, t + up + 1000);
}

describe('ClockSync (§8, D18)', () => {
  it('on a steady link, the offset is exact to half the asymmetry and the rtt is the link', () => {
    const sync = new ClockSync();
    for (let i = 0; i < 5; i += 1) sample(sync, i * 200, 40, 40);
    expect(sync.offset).toBe(1000);
    expect(sync.rtt).toBe(80);
  });

  it('on a lossy link, takes the offset from the exchange that waited least', () => {
    // 40 ms each way, but three of five exchanges sat behind a resend (200 ms, then 400 ms more):
    // two on the way back, one on the way up. A median would land on a delayed one.
    const sync = new ClockSync();
    sample(sync, 0, 40, 240); // pong resent: this sample thinks the server is 100 ms behind
    sample(sync, 200, 40, 640); // resent twice: 300 ms behind
    sample(sync, 400, 40, 40); // clean
    sample(sync, 600, 240, 40); // ping resent: 100 ms ahead
    sample(sync, 800, 40, 240);
    expect(sync.offset).toBe(1000);
    // The rtt stays the typical one, not the luckiest: it prices a press (ADR-0002).
    expect(sync.rtt).toBe(280);
  });

  it('forgets an old fast exchange once five newer ones have come in', () => {
    const sync = new ClockSync();
    sample(sync, 0, 10, 10); // fast, but on a clock that has since been corrected
    for (let i = 1; i <= 5; i += 1) sync.add(i * 200, i * 200 + 100, i * 200 + 50 + 2000);
    expect(sync.offset).toBe(2000);
  });
});
