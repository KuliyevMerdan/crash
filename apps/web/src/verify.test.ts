import { createChain, crashPoint } from '@crash/fair';
import type { GameView } from '@crash/client-core';
import { minor } from '@crash/money';
import type { RoundLink } from '@crash/protocol';
import { describe, expect, it } from 'vitest';
import {
  knownFrom,
  NOTHING_KNOWN,
  verdictOf,
  verifyRound,
  rHex,
  type FetchJson,
  type VerifyState,
} from './verify.js';

const SALT = 'crash-test-chain';
const EDGE = 100;
const CHAIN = createChain('0f'.repeat(32), 60, { checkpointEvery: 7 });
const OTHER = createChain('e1'.repeat(32), 60);
const ROUND_ID = '01J8ZQ3X0000000000000000AA';

const GAME: GameView = {
  player: { id: 'p', nick: 'me', balance: minor(1000) },
  config: {
    curve: { growthRatePerSecond: 0.15 },
    bettingPhaseMs: 7000,
    crashedPhaseMs: 3000,
    tickIntervalMs: 100,
    minBet: minor(100),
    maxBet: minor(50_000),
    maxAutoCashOut: 100_000,
    houseEdgeBps: EDGE,
  },
  chain: { id: 1, commit: CHAIN.commit, salt: SALT, length: CHAIN.length },
  round: { roundId: ROUND_ID, chainIndex: 10, phase: 'BETTING', bettingClosesAt: 1, bets: [] },
  myBets: [],
  history: [],
  withdrawn: [],
};

const listing = (commit = CHAIN.commit) => ({
  chains: [{ id: 1, commit, salt: SALT, length: CHAIN.length, houseEdgeBps: EDGE }],
});

const revealOf = (index: number, chain = CHAIN) => ({
  chainId: 1,
  chainIndex: index,
  seed: chain.seedAt(index),
  previousHash: index === 1 ? chain.commit : chain.seedAt(index - 1),
  crashPoint: crashPoint(chain.seedAt(index), SALT, EDGE),
  roundId: ROUND_ID,
});

function server(reveal: object | null, list: object = listing()): FetchJson & { asked: string[] } {
  const asked: string[] = [];
  const fetchJson = async (path: string) => {
    asked.push(path);
    if (path === '/fair/chains') return { status: 200, body: list };
    return reveal === null
      ? { status: 404, body: { error: 'not revealed' } }
      : { status: 200, body: reveal };
  };
  return Object.assign(fetchJson, { asked });
}

async function verify(
  link: RoundLink,
  fetchJson: FetchJson,
  extra: Partial<Parameters<typeof verifyRound>[1]> = {},
) {
  const updates: VerifyState[] = [];
  let pauses = 0;
  const final = await verifyRound(link, {
    fetchJson,
    pause: async () => void (pauses += 1),
    onUpdate: (s) => updates.push(s),
    slice: 7,
    ...extra,
  });
  return { final, updates, pauses };
}

function checkedOf(state: VerifyState) {
  if (state.stage !== 'done' && state.stage !== 'checking') throw new Error(`stage ${state.stage}`);
  return state.checked;
}

describe('verifyRound — an honest round', () => {
  it('fetches the chain and the reveal, and checks the link, the crash point and the commit', async () => {
    const fetchJson = server(revealOf(20));
    const { final, updates, pauses } = await verify({ chainId: 1, chainIndex: 20 }, fetchJson);
    expect(fetchJson.asked.sort()).toEqual(['/fair/1/20', '/fair/chains']);
    const c = checkedOf(final);
    expect(final.stage).toBe('done');
    expect(c.linkOk).toBe(true);
    expect(c.pointOk).toBe(true);
    expect(c.hashOfSeed).toBe(CHAIN.seedAt(19));
    expect(c.trace.crashPoint).toBe(crashPoint(CHAIN.seedAt(20), SALT, EDGE));
    expect(c.trace.hmac.startsWith(rHex(c.trace.r))).toBe(true);
    expect(c.walk).toEqual({ done: 20, total: 20, reached: CHAIN.commit });
    expect(verdictOf(c)).toBe('verified');
    // 20 hashes in slices of 7: the page was handed back between them, and saw the walk advance.
    expect(pauses).toBe(2);
    expect(updates.map((u) => u.stage)).toEqual([
      'loading',
      'checking',
      'checking',
      'checking',
      'done',
    ]);
    expect(updates.flatMap((u) => (u.stage === 'checking' ? [u.checked.walk.done] : []))).toEqual([
      0, 7, 14,
    ]);
    expect(verdictOf(checkedOf(updates[2] as VerifyState))).toBe('checking');
  });

  it('walks round 1 one hash to the commit', async () => {
    const { final } = await verify({ chainId: 1, chainIndex: 1 }, server(revealOf(1)));
    expect(verdictOf(checkedOf(final))).toBe('verified');
  });

  it('holds the result to the crash point this browser saw, and the commit it was handed', async () => {
    const link = { chainId: 1, chainIndex: 9 };
    const point = crashPoint(CHAIN.seedAt(9), SALT, EDGE);
    const c = checkedOf((await verify(link, server(revealOf(9)))).final);
    const browser = (watched: number | null, chain: { id: number; commit: string }): GameView => ({
      ...GAME,
      chain: { ...GAME.chain, ...chain },
      history:
        watched === null ? [] : [{ roundId: ROUND_ID, crashPoint: watched, link: { ...link } }],
    });

    const honest = knownFrom(browser(point, { id: 1, commit: CHAIN.commit }), c);
    expect(honest).toEqual({ seen: point, chainSeen: true });
    expect(verdictOf(c, honest)).toBe('verified');

    // Shown one number while playing, handed another to verify.
    const shownOther = knownFrom(browser(point + 1, { id: 1, commit: CHAIN.commit }), c);
    expect(verdictOf(c, shownOther)).toBe('failed');

    // A server that swapped the published commit after this browser joined.
    const swapped = knownFrom(browser(point, { id: 1, commit: OTHER.commit }), c);
    expect(swapped.chainSeen).toBe(false);
    expect(verdictOf(c, swapped)).toBe('failed');

    // …or its salt, which moves every crash point of the chain while the commit still holds.
    const resalted = knownFrom(
      {
        ...browser(point, { id: 1, commit: CHAIN.commit }),
        chain: { ...GAME.chain, salt: 'other' },
      },
      c,
    );
    expect(verdictOf(c, resalted)).toBe('failed');

    // A browser on another chain, or not yet joined, cannot speak to this commit — unknown, not failed.
    const elsewhere = knownFrom(browser(null, { id: 2, commit: OTHER.commit }), c);
    expect(elsewhere).toEqual(NOTHING_KNOWN);
    expect(verdictOf(c, elsewhere)).toBe('verified');
    expect(knownFrom(null, c)).toEqual(NOTHING_KNOWN);
  });
});

describe('verifyRound — a server that lies is caught here, not believed', () => {
  it('a forged seed does not hash to the previous one', async () => {
    const forged = { ...revealOf(12), seed: 'ab'.repeat(32) };
    const c = checkedOf((await verify({ chainId: 1, chainIndex: 12 }, server(forged))).final);
    expect(c.linkOk).toBe(false);
    expect(c.walk.reached).not.toBe(CHAIN.commit);
    expect(verdictOf(c)).toBe('failed');
  });

  it('a recorded crash point the seed does not produce', async () => {
    const real = revealOf(12);
    const lied = { ...real, crashPoint: real.crashPoint + 1 };
    const c = checkedOf((await verify({ chainId: 1, chainIndex: 12 }, server(lied))).final);
    expect(c.linkOk).toBe(true);
    expect(c.pointOk).toBe(false);
    expect(verdictOf(c)).toBe('failed');
  });

  it('a self-consistent round from another chain does not reach the published commit', async () => {
    const c = checkedOf(
      (await verify({ chainId: 1, chainIndex: 12 }, server(revealOf(12, OTHER)))).final,
    );
    expect(c.linkOk).toBe(true);
    expect(c.pointOk).toBe(true);
    expect(c.walk.reached).toBe(OTHER.commit);
    expect(verdictOf(c)).toBe('failed');
  });

  it('the same seed claimed at another index walks to the wrong place', async () => {
    const shifted = { ...revealOf(12), chainIndex: 13 };
    const { final } = await verify({ chainId: 1, chainIndex: 13 }, server(shifted));
    expect(verdictOf(checkedOf(final))).toBe('failed');
  });
});

describe('verifyRound — what it cannot check, it says', () => {
  it.each([
    ['an unrevealed round', server(null), /not been revealed/],
    ['a reveal for another round', server(revealOf(5)), /different round/],
    ['a reply outside the contract', server({ seed: 'nope' }), /not a chain list and a reveal/],
    ['an unknown chain', server(revealOf(12), { chains: [] }), /no chain 1/],
    [
      'an unreachable server',
      Object.assign(
        async () => {
          throw new TypeError('network');
        },
        { asked: [] },
      ),
      /Could not reach/,
    ],
  ])('%s', async (_name, fetchJson, message) => {
    const { final } = await verify({ chainId: 1, chainIndex: 12 }, fetchJson);
    expect(final.stage).toBe('error');
    if (final.stage === 'error') expect(final.message).toMatch(message);
  });

  it('stops walking, and stops reporting, once the page has moved on', async () => {
    const controller = new AbortController();
    const updates: VerifyState[] = [];
    await verifyRound(
      { chainId: 1, chainIndex: 50 },
      {
        fetchJson: server(revealOf(50)),
        pause: async () => controller.abort(),
        onUpdate: (s) => updates.push(s),
        signal: controller.signal,
        slice: 7,
      },
    );
    expect(updates.at(-1)?.stage).toBe('checking');
    expect(updates.some((u) => u.stage === 'done')).toBe(false);
  });
});
