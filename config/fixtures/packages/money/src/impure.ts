// FIXTURE — the purity rules reach @crash/money too; every line in the function must be rejected.
export function impure() {
  const roll = Math.random();
  const now = Date.now();
  const stamp = new Date();
  const mark = performance.now();
  const env = process.env.CRASH_EDGE;
  return { roll, now, stamp, mark, env };
}
