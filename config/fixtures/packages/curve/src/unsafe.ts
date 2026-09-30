// FIXTURE — each marked line must be rejected by the type-safety rules in eslint.config.mjs.
export function unsafe(input: unknown, list: number[]) {
  const loose: any = input; // no-explicit-any
  const first = list[0]!; // no-non-null-assertion
  const asserted = input as number; // consistent-type-assertions
  const fine = [1, 2] as const; // NOT flagged: a const assertion claims nothing about a value
  return { loose, first, asserted, fine };
}
