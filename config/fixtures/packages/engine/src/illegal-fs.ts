// FIXTURE — must be rejected by `packages-no-node-builtins`: no package does I/O or needs Node.
import { readFileSync } from 'node:fs';

export const leak = readFileSync;
