import type { GameView } from '@crash/client-core';
import { crashPointTrace, hashTimes, previousHashOf, type CrashPointTrace } from '@crash/fair';
import {
  chainListing,
  revealedRound,
  type ChainListing,
  type RevealedRound,
  type RoundLink,
} from '@crash/protocol';

/**
 * The verification page's work, with no DOM in it (ROADMAP C3, ADR-0001).
 *
 * The server is asked for two things — the chain's published parameters and the round's reveal —
 * and is **trusted for neither**: every check below runs here, in the browser, through
 * `@crash/fair`, the code the server itself used to draw the result. What the server says is only
 * the claim; the checks are what make it true or false.
 *
 * 1. **link** — `SHA256(seed)` is the seed revealed one round earlier (the commit, for round 1).
 * 2. **crash point** — `HMAC_SHA256(seed, salt)` read through the §3.2 formula gives the crash
 *    point the server recorded (and the one it showed this browser, when it showed one).
 * 3. **commit** — hashing the seed `chainIndex` times lands on the chain's commit: up to a million
 *    hashes, walked in slices so the page keeps drawing.
 * 4. **seen** — that commit, salt and edge are the ones this browser was handed in `hello` when it
 *    joined, before it ever bet. That is what makes the result older than the bet.
 */

export type ChainEntry = ChainListing['chains'][number];

/** Fetch a JSON document from the game server: its status, and the body when there is one. */
export type FetchJson = (
  path: string,
) => Promise<{ readonly status: number; readonly body: unknown }>;

export interface Checked {
  readonly link: RoundLink;
  readonly chain: ChainEntry;
  readonly reveal: RevealedRound;
  readonly trace: CrashPointTrace;
  /** `SHA256(seed)` — must equal `reveal.previousHash`. */
  readonly hashOfSeed: string;
  readonly linkOk: boolean;
  readonly pointOk: boolean;
  readonly walk: Walk;
}

/**
 * What this browser knows on its own, beside anything the server says now. Read afresh on every
 * render rather than once at the start: a page opened cold from a link is still joining the table
 * when the check begins, and its `hello` — with the commit — may land after the walk has started.
 */
export interface Known {
  /**
   * The crash point this browser was shown for the round — at its crash, or in `hello.history` —
   * `null` if it was shown none. What the server said then, held against what it says now.
   */
  readonly seen: number | null;
  /**
   * Are the chain's commit, salt and house edge the ones this browser was handed in `hello`? `null`
   * when it holds nothing for that chain: not joined yet, or playing another chain.
   */
  readonly chainSeen: boolean | null;
}

export const NOTHING_KNOWN: Known = { seen: null, chainSeen: null };

export function knownFrom(game: GameView | null, c: Checked): Known {
  if (game === null) return NOTHING_KNOWN;
  const shown = game.history.find(
    (h) => h.link?.chainId === c.link.chainId && h.link.chainIndex === c.link.chainIndex,
  );
  return {
    seen: shown?.crashPoint ?? null,
    // The three numbers that fix every crash point of the chain: a server that changed any of them
    // after this browser joined would change results it had already committed to.
    chainSeen:
      game.chain.id === c.chain.id
        ? game.chain.commit === c.chain.commit &&
          game.chain.salt === c.chain.salt &&
          game.config.houseEdgeBps === c.chain.houseEdgeBps
        : null,
  };
}

export interface Walk {
  /** Hashes taken so far, of `chainIndex`. */
  readonly done: number;
  readonly total: number;
  /** Where the walk landed — set when it is finished. */
  readonly reached: string | null;
}

export type VerifyState =
  | { readonly stage: 'loading'; readonly link: RoundLink }
  | { readonly stage: 'error'; readonly link: RoundLink; readonly message: string }
  | { readonly stage: 'checking' | 'done'; readonly checked: Checked };

export type Verdict = 'checking' | 'verified' | 'failed';

export function verdictOf(c: Checked, known: Known = NOTHING_KNOWN): Verdict {
  const commitOk = c.walk.reached === null ? null : c.walk.reached === c.chain.commit;
  const seenOk = known.seen === null || known.seen === c.trace.crashPoint;
  if (!c.linkOk || !c.pointOk || !seenOk || commitOk === false || known.chainSeen === false) {
    return 'failed';
  }
  return commitOk === null ? 'checking' : 'verified';
}

export interface VerifyDeps {
  readonly fetchJson: FetchJson;
  /** Hand the thread back to the browser between slices of the walk. */
  readonly pause: () => Promise<void>;
  readonly onUpdate: (state: VerifyState) => void;
  readonly signal?: AbortSignal;
  /**
   * Hashes per slice. 20,000 measured ≈25 ms a slice in headless Chromium — a dropped frame every
   * slice — so 10,000, which keeps the walk under a frame's budget at the cost of more breaks.
   */
  readonly slice?: number;
}

export async function verifyRound(link: RoundLink, deps: VerifyDeps): Promise<VerifyState> {
  const { fetchJson, pause, onUpdate, signal } = deps;
  const slice = deps.slice ?? 10_000;
  let state: VerifyState = { stage: 'loading', link };
  const emit = (next: VerifyState) => {
    state = next;
    if (!signal?.aborted) onUpdate(next);
    return next;
  };
  emit(state);
  const fail = (message: string) => emit({ stage: 'error', link, message });

  let chains: ChainListing;
  let reveal: RevealedRound;
  try {
    const [listed, revealed] = await Promise.all([
      fetchJson('/fair/chains'),
      fetchJson(`/fair/${link.chainId}/${link.chainIndex}`),
    ]);
    if (listed.status !== 200) return fail(`The server's chain list answered ${listed.status}.`);
    if (revealed.status === 404) {
      return fail(
        `Round ${link.chainIndex} of chain ${link.chainId} has not been revealed — a seed stays ` +
          `secret until its round crashes, and an index past the current round has not been played.`,
      );
    }
    if (revealed.status !== 200) return fail(`The server answered ${revealed.status}.`);
    // Parsed at the boundary like every message (CLAUDE.md § Other rules): a reply that does not
    // fit the contract is reported, not half-checked.
    const listParse = chainListing.safeParse(listed.body);
    const revealParse = revealedRound.safeParse(revealed.body);
    if (!listParse.success || !revealParse.success) {
      return fail('The server answered with something that is not a chain list and a reveal.');
    }
    chains = listParse.data;
    reveal = revealParse.data;
  } catch {
    return fail('Could not reach the server to fetch the reveal.');
  }
  if (signal?.aborted) return state;

  const chain = chains.chains.find((c) => c.id === link.chainId);
  if (chain === undefined) return fail(`The server publishes no chain ${link.chainId}.`);
  if (reveal.chainId !== link.chainId || reveal.chainIndex !== link.chainIndex) {
    return fail('The server revealed a different round from the one asked for.');
  }

  const trace = crashPointTrace(reveal.seed, chain.salt, chain.houseEdgeBps);
  const hashOfSeed = previousHashOf(reveal.seed);
  const base = {
    link,
    chain,
    reveal,
    trace,
    hashOfSeed,
    linkOk: hashOfSeed === reveal.previousHash,
    pointOk: trace.crashPoint === reveal.crashPoint,
  };

  // The walk: `chainIndex` hashes from the seed, a slice at a time.
  let current = reveal.seed;
  let done = 0;
  const total = link.chainIndex;
  emit({ stage: 'checking', checked: { ...base, walk: { done, total, reached: null } } });
  while (done < total) {
    const step = Math.min(slice, total - done);
    current = hashTimes(current, step);
    done += step;
    if (done < total) {
      emit({ stage: 'checking', checked: { ...base, walk: { done, total, reached: null } } });
      await pause();
      if (signal?.aborted) return state;
    }
  }
  return emit({ stage: 'done', checked: { ...base, walk: { done, total, reached: current } } });
}

/** `fetch`, as the page uses it: same origin, JSON or nothing. */
export const browserFetchJson: FetchJson = async (path) => {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
};

/** A macrotask break, so a frame can be drawn between slices of the walk. */
export function browserPause(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

/** `r` as the page prints it: its 13 hex digits, which are the first 13 of the HMAC. */
export function rHex(r: bigint): string {
  return r.toString(16).padStart(13, '0');
}
