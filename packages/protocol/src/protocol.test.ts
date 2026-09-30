import { describe, expect, it } from 'vitest';
import { CLIENT_FIXTURES, FAIR, IDS, SERVER_FIXTURES } from './__fixtures__/messages.js';
import {
  CLIENT_MESSAGE_TYPES,
  ERROR_CODES,
  SERVER_MESSAGE_TYPES,
  chainListing,
  classOf,
  decodeFrame,
  errorMessageOf,
  gameConfig,
  myBet,
  parseClientMessage,
  parseServerMessage,
  revealedRound,
  roundSnapshot,
} from './index.js';

describe('every message has a fixture, and every fixture parses', () => {
  it('covers each client message type exactly', () => {
    expect(Object.keys(CLIENT_FIXTURES).sort()).toEqual([...CLIENT_MESSAGE_TYPES].sort());
  });

  it('covers each server message type exactly', () => {
    expect(Object.keys(SERVER_FIXTURES).sort()).toEqual([...SERVER_MESSAGE_TYPES].sort());
  });

  it.each(Object.entries(CLIENT_FIXTURES))('parses the client fixture %s', (_type, fixture) => {
    const outcome = parseClientMessage(fixture);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.message).toEqual(fixture);
  });

  it.each(Object.entries(SERVER_FIXTURES))('parses the server fixture %s', (_type, fixture) => {
    const outcome = parseServerMessage(fixture);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.message).toEqual(fixture);
  });

  it('survives a JSON round trip, as it would off a socket', () => {
    for (const fixture of Object.values(SERVER_FIXTURES)) {
      expect(parseServerMessage(decodeFrame(JSON.stringify(fixture))).kind).toBe('ok');
    }
  });
});

describe('invariant 9 — unknown is dropped, not refused', () => {
  it('strips unknown fields', () => {
    const outcome = parseServerMessage({ ...SERVER_FIXTURES.tick, debug: { cpu: 0.3 } });
    expect(outcome).toEqual({ kind: 'ok', message: SERVER_FIXTURES.tick });
  });

  it('strips an autoCashOutAt that a buggy server leaked into a broadcast (D4)', () => {
    const outcome = parseServerMessage({ ...SERVER_FIXTURES.betPlaced, autoCashOutAt: 200 });
    expect(outcome.kind === 'ok' && 'autoCashOutAt' in outcome.message).toBe(false);
  });

  it.each([
    [{ type: 'chat', text: 'hi' }, 'chat'],
    [{ type: 'betRejected', betId: IDS.BET }, 'betRejected'], // gone since D8 — dropped, not parsed
    [{ nothing: true }, undefined],
    [null, undefined],
    [42, undefined],
    [{ type: 7 }, undefined],
  ])('drops %j as an unknown type', (value, type) => {
    expect(parseServerMessage(value)).toEqual({ kind: 'unknown-type', type });
  });

  it('treats a frame that is not JSON as an unknown type', () => {
    expect(parseClientMessage(decodeFrame('{not json'))).toEqual({
      kind: 'unknown-type',
      type: undefined,
    });
  });

  it('does not accept a server message on the client side of the parser, or vice versa', () => {
    expect(parseClientMessage(SERVER_FIXTURES.tick).kind).toBe('unknown-type');
    expect(parseServerMessage(CLIENT_FIXTURES.cashOut).kind).toBe('unknown-type');
  });
});

describe('a known type with a bad payload is malformed, and says where', () => {
  it.each([
    ['a float multiplier', { ...SERVER_FIXTURES.tick, multiplier: 1.66 }, 'multiplier'],
    ['a multiplier below 1.00×', { ...SERVER_FIXTURES.tick, multiplier: 99 }, 'multiplier'],
    [
      'a multiplier past the ceiling',
      { ...SERVER_FIXTURES.tick, multiplier: 100_000_001 },
      'multiplier',
    ],
    ['a negative balance', { ...SERVER_FIXTURES.betCancelled, balance: -1 }, 'balance'],
    ['a fractional balance', { ...SERVER_FIXTURES.betCancelled, balance: 0.5 }, 'balance'],
    [
      'a prefixed hash (D12)',
      { ...SERVER_FIXTURES.crash, fair: { ...FAIR, previousHash: `sha256:${'a'.repeat(64)}` } },
      'fair.previousHash',
    ],
    [
      'a lowercase ULID',
      { ...SERVER_FIXTURES.roundStart, roundId: IDS.ROUND.toLowerCase() },
      'roundId',
    ],
    ['a missing reason', { ...SERVER_FIXTURES.cashOutResult, reason: undefined }, 'reason'],
  ])('%s', (_label, value, path) => {
    const outcome = parseServerMessage(value);
    expect(outcome.kind).toBe('malformed');
    if (outcome.kind === 'malformed') expect(outcome.issues.join('\n')).toContain(`${path}:`);
  });

  it.each([
    ['a zero stake', { ...CLIENT_FIXTURES.placeBet, amount: 0 }],
    ['an auto cash-out at 1.00×', { ...CLIENT_FIXTURES.placeBet, autoCashOutAt: 100 }],
    ['an empty nick', { ...CLIENT_FIXTURES.authenticate, nick: '   ' }],
    ['a nick of 17 characters', { ...CLIENT_FIXTURES.authenticate, nick: 'x'.repeat(17) }],
    ['a cash-out without a betId', { type: 'cashOut' }],
  ])('refuses %s from a client', (_label, value) => {
    expect(parseClientMessage(value).kind).toBe('malformed');
  });

  it('trims a nick rather than refusing it', () => {
    const outcome = parseClientMessage({ ...CLIENT_FIXTURES.authenticate, nick: '  ada  ' });
    expect(
      outcome.kind === 'ok' && outcome.message.type === 'authenticate' && outcome.message.nick,
    ).toBe('ada');
  });

  it('ignores a multiplier a client tries to send with a cash-out (ADR-0002)', () => {
    const outcome = parseClientMessage({ ...CLIENT_FIXTURES.cashOut, multiplier: 100_000 });
    expect(outcome).toEqual({ kind: 'ok', message: CLIENT_FIXTURES.cashOut });
  });
});

describe('errors — the class is a function of the code', () => {
  it.each(
    (['PLAYER', 'SESSION', 'SYSTEM'] as const).flatMap((cls) =>
      ERROR_CODES[cls].map((code) => [code, cls] as const),
    ),
  )('%s is %s', (code, cls) => {
    expect(classOf(code)).toBe(cls);
    expect(parseServerMessage({ type: 'error', class: cls, code, message: '' }).kind).toBe('ok');
  });

  it('refuses an error whose class disagrees with its code', () => {
    expect(
      parseServerMessage({ type: 'error', class: 'SYSTEM', code: 'TOO_LATE', message: '' }).kind,
    ).toBe('malformed');
  });

  it('allows a connection-level error with no roundId or betId (invariant 8)', () => {
    const outcome = parseServerMessage({
      type: 'error',
      class: 'SESSION',
      code: 'NOT_AUTHENTICATED',
      message: 'authenticate first',
    });
    expect(outcome.kind).toBe('ok');
  });

  it('builds every code into an error the parser accepts, with its class stamped from the table', () => {
    for (const cls of ['PLAYER', 'SESSION', 'SYSTEM'] as const) {
      for (const code of ERROR_CODES[cls]) {
        const message = errorMessageOf(code, 'x', { betId: IDS.BET });
        expect(message.class).toBe(cls);
        expect(parseServerMessage(message)).toEqual({ kind: 'ok', message });
      }
    }
    expect(errorMessageOf('NOT_AUTHENTICATED', 'authenticate first')).toEqual({
      type: 'error',
      class: 'SESSION',
      code: 'NOT_AUTHENTICATED',
      message: 'authenticate first',
    });
  });

  it('keeps every code in exactly one class', () => {
    const all = [...ERROR_CODES.PLAYER, ...ERROR_CODES.SESSION, ...ERROR_CODES.SYSTEM];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('snapshots carry exactly the fields true in their phase', () => {
  const base = { roundId: IDS.ROUND, chainIndex: 3, bets: [] };

  it('accepts each phase', () => {
    expect(roundSnapshot.safeParse({ ...base, phase: 'BETTING', bettingClosesAt: 1 }).success).toBe(
      true,
    );
    expect(roundSnapshot.safeParse({ ...base, phase: 'RUNNING', startedAt: 1 }).success).toBe(true);
    expect(
      roundSnapshot.safeParse({
        ...base,
        phase: 'CRASHED',
        startedAt: 1,
        crashedAt: 2,
        crashPoint: 100,
        fair: FAIR,
      }).success,
    ).toBe(true);
  });

  it('refuses a CRASHED round without its reveal, and a RUNNING one without startedAt', () => {
    expect(
      roundSnapshot.safeParse({
        ...base,
        phase: 'CRASHED',
        startedAt: 1,
        crashedAt: 2,
        crashPoint: 100,
      }).success,
    ).toBe(false);
    expect(roundSnapshot.safeParse({ ...base, phase: 'RUNNING' }).success).toBe(false);
  });

  it('does not let a RUNNING snapshot carry a crash point — stripped, never parsed through', () => {
    const parsed = roundSnapshot.parse({
      ...base,
      phase: 'RUNNING',
      startedAt: 1,
      crashPoint: 5000,
    });
    expect('crashPoint' in parsed).toBe(false);
  });

  it('restores each private bet status, and refuses a cash-out without its payout', () => {
    const fields = { roundId: IDS.ROUND, betId: IDS.BET, amount: 500 };
    expect(myBet.safeParse({ ...fields, status: 'LOST' }).success).toBe(true);
    expect(
      myBet.safeParse({
        ...fields,
        status: 'CASHED_OUT',
        reason: 'AUTO',
        multiplier: 200,
        payout: 1000,
      }).success,
    ).toBe(true);
    expect(
      myBet.safeParse({ ...fields, status: 'CASHED_OUT', reason: 'AUTO', multiplier: 200 }).success,
    ).toBe(false);
  });

  it('refuses a config whose minimum bet exceeds its maximum', () => {
    const config = SERVER_FIXTURES.hello.config;
    expect(gameConfig.safeParse({ ...config, minBet: 60_000 }).success).toBe(false);
  });
});

describe('the HTTP surface (§3.3)', () => {
  it('parses a chain listing and a revealed round', () => {
    expect(
      chainListing.safeParse({
        chains: [
          {
            id: 1,
            commit: IDS.COMMIT,
            salt: 'crash-demo-chain-1',
            length: 1_000_000,
            houseEdgeBps: 100,
          },
        ],
      }).success,
    ).toBe(true);
    expect(revealedRound.safeParse({ ...FAIR, crashPoint: 247, roundId: IDS.ROUND }).success).toBe(
      true,
    );
  });
});
