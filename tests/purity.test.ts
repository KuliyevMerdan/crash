import { describe, expect, it } from 'vitest';
import { eslint } from './lint-runner';

/**
 * Proves the purity rules fire, in every package they are meant to hold.
 *
 * `engine`, `curve`, `fair` and `money` take time as a parameter and randomness as a seed. Ambient
 * either anywhere in them destroys replay quietly — the tests keep passing, they stop meaning
 * anything — so the rule that forbids it is itself tested. One fixture per package, because a
 * package missing from the rule's list is the likeliest way for it to stop applying.
 */

describe.each(['engine', 'curve', 'fair', 'money'])('purity rules hold @crash/%s', (pkg) => {
  const messages = eslint(`config/fixtures/packages/${pkg}/src/impure.ts`);
  const syntax = messages.filter((m) => m.ruleId === 'no-restricted-syntax');

  it.each([
    ['Math.random()', 3, /seed, from `fair`/],
    ['Date.now()', 4, /Time is a parameter/],
    ['new Date()', 5, /Time is a parameter/],
    ['performance.now()', 6, /Time is a parameter/],
  ])('rejects %s', (_label, line, expected) => {
    expect(syntax.find((m) => m.line === line)?.message).toMatch(expected);
  });

  it('rejects ambient config through process', () => {
    expect(messages.filter((m) => m.ruleId === 'no-restricted-globals').map((m) => m.line)).toEqual(
      [7],
    );
  });

  it('reports one violation per offending line and nothing else', () => {
    expect(syntax).toHaveLength(4);
  });
});
