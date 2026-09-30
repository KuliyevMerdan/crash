/**
 * @crash/renderer — the curve, the counter and the crash, on Canvas 2D. It draws numbers; it never
 * sees a message (CLAUDE.md § Dependency rules). The app builds a `Frame` from its state every
 * animation frame; this package turns it into pixels.
 */
export { CrashRenderer, type Frame, type Drawn, type Ctx } from './renderer.js';
export {
  extents,
  multiplierTicks,
  timeTicks,
  formatMultiplier,
  formatTick,
  type Extents,
} from './viewport.js';
