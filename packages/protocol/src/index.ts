/**
 * @crash/protocol — the wire contract (docs/protocol.md) as zod schemas and the types inferred from
 * them. The document leads; this package follows it in the same commit, always.
 *
 * Importable by a Node and a browser target alike: zod and `@crash/money`, nothing else.
 */
export * from './primitives.js';
export * from './errors.js';
export * from './snapshot.js';
export * from './messages.js';
export * from './parse.js';
