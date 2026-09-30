/**
 * @crash/fair — the hash chain, `HMAC → crashPoint`, and chain-link verification.
 *
 * Isomorphic: the server that produces a result and the verification page where a player checks it
 * run this same code (ADR-0001). No Node API, no DOM API, no dependency — enforced by the boundary
 * rules and the base tsconfig, and exercised under both environments by `isomorphic.test.ts`.
 */
export { MIN_CRASH_POINT, MAX_CRASH_POINT, crashPoint, crashPointFromBits } from './crash-point.js';
export {
  type Chain,
  type ChainOptions,
  createChain,
  previousHashOf,
  verifyLink,
  verifyToCommit,
} from './chain.js';
export { sha256, hmacSha256 } from './sha256.js';
export { bytesToHex, hexToBytes, isHash, utf8 } from './bytes.js';
