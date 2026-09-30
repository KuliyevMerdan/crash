// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { GOLDEN, SALT } from './__fixtures__/golden.js';
import { bytesToHex, createChain, crashPoint, sha256, utf8, verifyToCommit } from './index.js';

/**
 * ROADMAP S1: `fair` runs under both Node and a DOM environment. The rest of this package's suite
 * runs in Node; this file runs in happy-dom, with `window` and `document` present, and must reach
 * the same answers — the verification page's situation exactly.
 */
describe('fair in a DOM environment', () => {
  it('really is one', () => {
    // Read through globalThis: the package has no DOM lib, which is the point of it.
    expect('window' in globalThis).toBe(true);
    expect(typeof Reflect.get(globalThis, 'document')).toBe('object');
  });

  it('hashes the NIST "abc" vector', () => {
    expect(bytesToHex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it.each(GOLDEN)('reproduces the golden crash point for %s', (seed, expected) => {
    expect(crashPoint(seed, SALT, 100)).toBe(expected);
  });

  it('builds and verifies a chain', () => {
    const chain = createChain('11'.repeat(32), 300, { checkpointEvery: 16 });
    expect(verifyToCommit(chain.seedAt(123), 123, chain.commit)).toBe(true);
  });
});
