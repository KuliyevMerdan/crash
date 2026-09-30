// FIXTURE — must be rejected by `sim-deps` and `nothing-imports-apps`: the sim measures the engine,
// not a server that happens to wrap it.
import { start } from '@crash/server';

export const leak = start;
