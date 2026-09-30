import { describe, expect, it } from 'vitest';
import { eslint } from './lint-runner';

/**
 * Proves CLAUDE.md's "no `any`, no non-null `!`, no `as`" is enforced rather than hoped for — and
 * that `as const`, which claims nothing about a value, is not caught in the net.
 */

describe('type-safety rules in source', () => {
  const messages = eslint('config/fixtures/packages/curve/src/unsafe.ts');
  const lineOf = (rule: string) =>
    messages.filter((m) => m.ruleId === `@typescript-eslint/${rule}`).map((m) => m.line);

  it.each([
    ['no-explicit-any', 3],
    ['no-non-null-assertion', 4],
    ['consistent-type-assertions', 5],
  ])('rejects %s', (rule, line) => {
    expect(lineOf(rule)).toEqual([line]);
  });

  it('leaves `as const` alone', () => {
    expect(messages.filter((m) => m.line === 6)).toEqual([]);
  });
});
