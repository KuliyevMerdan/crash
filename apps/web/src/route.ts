import type { RoundLink } from '@crash/protocol';

/**
 * The page's two screens, kept in the URL hash so a verification link works from anywhere — pasted
 * into a chat, opened cold, served by any static host without a rewrite rule.
 *
 * - `#/verify/1/84213` — check round 84213 of chain 1
 * - `#/verify` — the form, empty
 * - anything else — the game
 */
export type Route =
  { readonly page: 'game' } | { readonly page: 'verify'; readonly link: RoundLink | null };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] !== 'verify') return { page: 'game' };
  if (parts.length === 1) return { page: 'verify', link: null };
  const chainId = positive(parts[1]);
  const chainIndex = positive(parts[2]);
  if (parts.length !== 3 || chainId === null || chainIndex === null) {
    return { page: 'verify', link: null };
  }
  return { page: 'verify', link: { chainId, chainIndex } };
}

export function verifyHref(link: RoundLink): string {
  return `#/verify/${link.chainId}/${link.chainIndex}`;
}

/**
 * What a stranger might paste into the verifier's one box: a round number (on the chain the client
 * is playing), `chain:round` or `chain/round`, or a whole verification link. `null` if it is none
 * of those.
 */
export function parseRoundRef(text: string, defaultChainId: number | null): RoundLink | null {
  const trimmed = text.trim();
  const fromLink = /#\/verify\/(\d+)\/(\d+)\s*$/.exec(trimmed);
  const pair = fromLink ?? /^(\d+)\s*[:/]\s*(\d+)$/.exec(trimmed);
  if (pair) {
    const chainId = positive(pair[1]);
    const chainIndex = positive(pair[2]);
    return chainId !== null && chainIndex !== null ? { chainId, chainIndex } : null;
  }
  const chainIndex = positive(trimmed.replace(/^#/, ''));
  if (chainIndex === null || defaultChainId === null) return null;
  return { chainId: defaultChainId, chainIndex };
}

function positive(text: string | undefined): number | null {
  if (text === undefined || !/^\d{1,15}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}
