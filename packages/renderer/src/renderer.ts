import { curve as makeCurve, multiplierAt, smoothMultiplierAt, type Curve } from '@crash/curve';
import { extents, formatMultiplier, formatTick, multiplierTicks, timeTicks } from './viewport.js';

/**
 * What to draw this frame — numbers, not messages. The renderer never sees the wire (CLAUDE.md §
 * Dependency rules: `renderer` may not import `protocol`); the app turns its state into one of these
 * every animation frame.
 */
export type Frame =
  | { readonly kind: 'idle'; readonly message: string }
  | {
      readonly kind: 'waiting';
      readonly closesInMs: number;
      readonly bettingMs: number;
      readonly lastCrash: number | null;
    }
  | { readonly kind: 'running'; readonly elapsedMs: number }
  | {
      readonly kind: 'crashed';
      /** `crashedAt − startedAt` — the curve is drawn to exactly here, never past it. */
      readonly elapsedMs: number;
      readonly crashPoint: number;
      readonly sinceCrashMs: number;
      readonly nextInMs: number;
      readonly note: string | null;
    };

/** What the frame showed — for the dev hooks, the perf probe and the tests. */
export interface Drawn {
  readonly kind: Frame['kind'];
  /** The counter, in hundredths, or `null` when it is not a multiplier. */
  readonly multiplier: number | null;
}

/** The part of `CanvasRenderingContext2D` this renderer uses — and all a test has to fake. */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'clearRect'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'stroke'
  | 'fill'
  | 'arc'
  | 'fillText'
  | 'createLinearGradient'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineJoin'
  | 'lineCap'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'globalAlpha'
>;

const COLORS = {
  background: '#0b1020',
  grid: 'rgba(148, 163, 184, 0.10)',
  label: 'rgba(148, 163, 184, 0.62)',
  text: '#e2e8f0',
  muted: 'rgba(226, 232, 240, 0.55)',
  crash: '#f43f5e',
  // The line warms as the round climbs: calm under 2×, hot past 10×.
  tiers: [
    { below: 200, line: '#2dd4bf' },
    { below: 1000, line: '#fbbf24' },
    { below: Infinity, line: '#f472b6' },
  ],
} as const;

const PAD = { left: 52, right: 18, top: 18, bottom: 30 };
const SEGMENTS = 96;
const SPARKS = 18;

/**
 * The curve, the counter and the crash on Canvas 2D.
 *
 * Driven by elapsed time alone — the app hands in `serverNow − startedAt` every animation frame, and
 * ticks never reach this layer (CLAUDE.md: "ticks correct drift; they do not drive frames"). Little
 * is allocated per frame: the axes are pure functions, the crash sparks are a pure function of time
 * since the crash, the fonts are computed on resize. What remains is small and bounded — one
 * gradient, a few colour strings and four short closures per frame — and C1's perf run measures
 * the heap across a whole round rather than assuming it flat.
 * No `shadowBlur`: the glow is a wide translucent stroke under the line, which a weak mobile GPU
 * draws for the price of one more stroke.
 */
export class CrashRenderer {
  private curve: Curve;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private counterFont = '';
  private labelFont = '';
  private subFont = '';

  constructor(
    private readonly ctx: Ctx,
    growthRatePerSecond: number,
  ) {
    this.curve = makeCurve(growthRatePerSecond);
  }

  /** From `hello.config.curve` — never hardcoded (docs/protocol.md §3.1). */
  setGrowthRate(growthRatePerSecond: number): void {
    this.curve = makeCurve(growthRatePerSecond);
  }

  /** The canvas's CSS size and the device pixel ratio its backing store was sized for. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.width = cssWidth;
    this.height = cssHeight;
    this.dpr = dpr;
    const short = Math.min(cssWidth, cssHeight);
    const family = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
    this.counterFont = `800 ${Math.round(Math.max(36, short * 0.2))}px ${family}`;
    this.subFont = `600 ${Math.round(Math.max(13, short * 0.045))}px ${family}`;
    this.labelFont = `500 11px ${family}`;
  }

  draw(frame: Frame): Drawn {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);

    switch (frame.kind) {
      case 'idle':
        this.grid(extents(0, 1));
        this.caption(frame.message, this.height / 2, COLORS.muted, this.subFont);
        return { kind: 'idle', multiplier: null };

      case 'waiting': {
        this.grid(extents(0, 1));
        const seconds = Math.max(0, frame.closesInMs) / 1000;
        this.caption(
          'NEXT ROUND',
          this.height / 2 - this.subSize() * 1.6,
          COLORS.muted,
          this.subFont,
        );
        this.caption(
          `${seconds.toFixed(1)}s`,
          this.height / 2 + this.counterSize() * 0.2,
          COLORS.text,
          this.counterFont,
        );
        this.progress(1 - Math.min(1, Math.max(0, frame.closesInMs / frame.bettingMs)));
        if (frame.lastCrash !== null) {
          this.caption(
            `last round ${formatMultiplier(frame.lastCrash)}`,
            this.height - PAD.bottom - 16,
            COLORS.muted,
            this.labelFont,
          );
        }
        return { kind: 'waiting', multiplier: null };
      }

      case 'running': {
        const shown = multiplierAt(this.curve, frame.elapsedMs);
        // The counter sits behind the line, the way the eye reads it: the number is the backdrop,
        // the curve is the thing moving.
        const view = this.plot(frame.elapsedMs, lineColor(shown), false, () =>
          this.caption(formatMultiplier(shown), this.counterY(), COLORS.text, this.counterFont),
        );
        this.head(view.headX, view.headY, lineColor(shown));
        return { kind: 'running', multiplier: shown };
      }

      case 'crashed': {
        const view = this.plot(frame.elapsedMs, COLORS.crash, true, () => {
          this.caption(
            formatMultiplier(frame.crashPoint),
            this.counterY(),
            COLORS.crash,
            this.counterFont,
          );
          this.caption(
            'CRASHED',
            this.counterY() + this.counterSize() * 0.62,
            COLORS.crash,
            this.subFont,
          );
          if (frame.note !== null) {
            const y = this.counterY() + this.counterSize() * 0.62 + this.subSize() * 1.6;
            this.caption(frame.note, y, COLORS.muted, this.labelFont);
          }
        });
        this.sparks(view.headX, view.headY, frame.sinceCrashMs);
        const next = Math.max(0, frame.nextInMs) / 1000;
        this.caption(
          `next round in ${next.toFixed(1)}s`,
          this.height - PAD.bottom - 16,
          COLORS.muted,
          this.labelFont,
        );
        return { kind: 'crashed', multiplier: frame.crashPoint };
      }
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────────────────────────

  /** Grid, then `underlay`, then area and line from 0 to `elapsedMs`; returns where the line ends. */
  private plot(
    elapsedMs: number,
    color: string,
    crashed: boolean,
    underlay: () => void,
  ): { headX: number; headY: number } {
    const { ctx } = this;
    const t = Math.max(0, elapsedMs);
    const endMultiple = smoothMultiplierAt(this.curve, t) / 100;
    const view = extents(t / 1000, endMultiple);
    this.grid(view);
    underlay();

    const x0 = PAD.left;
    const y0 = this.height - PAD.bottom;
    const w = this.width - PAD.left - PAD.right;
    const h = this.height - PAD.top - PAD.bottom;
    const toX = (ms: number) => x0 + (ms / 1000 / view.xMaxS) * w;
    const toY = (multiple: number) => y0 - ((multiple - 1) / (view.yMax - 1)) * h;

    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(1));
      for (let i = 1; i <= SEGMENTS; i += 1) {
        const ms = (t * i) / SEGMENTS;
        ctx.lineTo(toX(ms), toY(smoothMultiplierAt(this.curve, ms) / 100));
      }
    };

    // The area under the line.
    trace();
    ctx.lineTo(toX(t), y0);
    ctx.lineTo(toX(0), y0);
    ctx.closePath();
    const area = ctx.createLinearGradient(0, PAD.top, 0, y0);
    area.addColorStop(0, withAlpha(color, crashed ? 0.16 : 0.28));
    area.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = area;
    ctx.fill();

    // Glow, then the line.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    trace();
    ctx.strokeStyle = withAlpha(color, 0.22);
    ctx.lineWidth = 12;
    ctx.stroke();
    trace();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.stroke();

    return { headX: toX(t), headY: toY(endMultiple) };
  }

  private grid(view: { xMaxS: number; yMax: number }): void {
    const { ctx } = this;
    const x0 = PAD.left;
    const y0 = this.height - PAD.bottom;
    const w = this.width - PAD.left - PAD.right;
    const h = this.height - PAD.top - PAD.bottom;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.label;
    ctx.font = this.labelFont;

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const m of multiplierTicks(view.yMax)) {
      const y = Math.round(y0 - ((m - 1) / (view.yMax - 1)) * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + w, y);
      ctx.stroke();
      ctx.fillText(formatTick(m), x0 - 8, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const s of timeTicks(view.xMaxS)) {
      const x = Math.round(x0 + (s / view.xMaxS) * w) + 0.5;
      ctx.fillText(`${s}s`, x, y0 + 8);
    }
    // The baseline — 1.00×, where every round starts.
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.beginPath();
    ctx.moveTo(x0, y0 + 0.5);
    ctx.lineTo(x0 + w, y0 + 0.5);
    ctx.stroke();
  }

  private head(x: number, y: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = withAlpha(color, 0.25);
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  /** The burst at the break — a pure function of time since the crash: no particle state at all. */
  private sparks(x: number, y: number, sinceMs: number): void {
    const life = 700;
    if (sinceMs >= life) return;
    const { ctx } = this;
    const p = Math.max(0, sinceMs) / life;
    const ease = 1 - (1 - p) * (1 - p);
    ctx.fillStyle = COLORS.crash;
    for (let i = 0; i < SPARKS; i += 1) {
      const angle = (i / SPARKS) * Math.PI * 2 + (i % 3) * 0.35;
      const reach = (28 + (i % 5) * 9) * ease;
      ctx.globalAlpha = 1 - p;
      ctx.beginPath();
      ctx.arc(
        x + Math.cos(angle) * reach,
        y + Math.sin(angle) * reach + 30 * p * p,
        2.6 * (1 - p) + 0.6,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private progress(fraction: number): void {
    const { ctx } = this;
    const w = Math.min(260, this.width * 0.5);
    const x = (this.width - w) / 2;
    const y = this.height / 2 + this.counterSize() * 0.75;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = '#2dd4bf';
    ctx.fillRect(x, y, w * fraction, 4);
  }

  private caption(text: string, y: number, color: string, font: string): void {
    const { ctx } = this;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, PAD.left + (this.width - PAD.left - PAD.right) / 2, y);
  }

  private counterY(): number {
    return PAD.top + (this.height - PAD.top - PAD.bottom) * 0.38;
  }

  private counterSize(): number {
    return Math.max(36, Math.min(this.width, this.height) * 0.2);
  }

  private subSize(): number {
    return Math.max(13, Math.min(this.width, this.height) * 0.045);
  }
}

function lineColor(hundredths: number): string {
  for (const tier of COLORS.tiers) if (hundredths < tier.below) return tier.line;
  return COLORS.tiers[COLORS.tiers.length - 1]?.line ?? '#ffffff';
}

/** `#rrggbb` with an alpha, as `rgba(…)`. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
