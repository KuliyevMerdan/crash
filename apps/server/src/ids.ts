import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 48 bits of millisecond time, 80 bits of CSPRNG — `roundId`s and `playerId`s. */
export function ulid(now: number): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let random = '';
  for (const byte of randomBytes(16)) random += CROCKFORD.charAt(byte % 32);
  return time + random;
}

/** A session token: 32 bytes of CSPRNG. It names a wallet; it is not a security boundary (§2.1). */
export function token(): string {
  return randomBytes(32).toString('base64url');
}

/** A chain's `s₀`: 32 bytes of CSPRNG, as hex (docs/protocol.md §3.3). */
export function chainSeed(): string {
  return randomBytes(32).toString('hex');
}
