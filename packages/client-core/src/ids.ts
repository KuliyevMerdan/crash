const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID for a `betId` — generated **per intent to bet, not per send** (docs/protocol.md §7), so a
 * retry is provably the same bet. Time from the client's clock, randomness from the caller, so a
 * test's bets are reproducible.
 */
export function ulid(now: number, random: () => number): string {
  let time = '';
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let tail = '';
  for (let i = 0; i < 16; i += 1) tail += CROCKFORD.charAt(Math.floor(random() * 32) % 32);
  return time + tail;
}
