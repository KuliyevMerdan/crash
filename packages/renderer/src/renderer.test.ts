import { curve, multiplierAt } from '@crash/curve';
import { describe, expect, it } from 'vitest';
import {
  CrashRenderer,
  extents,
  formatMultiplier,
  formatTick,
  multiplierTicks,
  timeTicks,
  type Ctx,
  type Frame,
} from './index.js';

const K = curve(0.15);

/**
 * A 2D context that records every call and refuses a non-finite number — a `NaN` reaching the
 * canvas draws nothing and says nothing, which is exactly the bug a screenshot never shows.
 */
function recorder() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const texts: Array<{ text: string; color: unknown }> = [];
  const state: Record<string, unknown> = {};
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      for (const a of args)
        if (typeof a === 'number' && !Number.isFinite(a))
          throw new Error(`${op}(${args.join(', ')})`);
      calls.push({ op, args });
      if (op === 'fillText') texts.push({ text: String(args[0]), color: state['fillStyle'] });
      if (op === 'createLinearGradient') return { addColorStop: () => undefined };
      return undefined;
    };
  const ops = [
    'setTransform',
    'clearRect',
    'fillRect',
    'beginPath',
    'moveTo',
    'lineTo',
    'closePath',
    'stroke',
    'fill',
    'arc',
    'fillText',
    'createLinearGradient',
  ];
  const ctx = new Proxy(state, {
    get: (target, key) =>
      typeof key === 'string' && ops.includes(key) ? record(key) : target[key as string],
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as Ctx;
  return { ctx, calls, texts };
}

function setup() {
  const r = recorder();
  const renderer = new CrashRenderer(r.ctx, 0.15);
  renderer.resize(390, 600, 2);
  return { ...r, renderer };
}

describe('the axes (the "past ~20×" gap)', () => {
  it('move smoothly: no frame of a 90-second round shifts either extent by more than 2%', () => {
    let previous = extents(0, 1);
    for (let ms = 16; ms <= 92_000; ms += 16) {
      const next = extents(ms / 1000, multiplierAt(K, ms) / 100);
      expect(Math.abs(next.xMaxS - previous.xMaxS) / previous.xMaxS).toBeLessThan(0.02);
      expect(Math.abs(next.yMax - previous.yMax) / previous.yMax).toBeLessThan(0.02);
      previous = next;
    }
  });

  it('always keep the head of the curve inside the chart, with headroom', () => {
    for (const ms of [0, 1000, 4621, 15_351, 30_702, 60_000, 92_104]) {
      const m = multiplierAt(K, ms) / 100;
      const view = extents(ms / 1000, m);
      expect(view.xMaxS).toBeGreaterThan(ms / 1000);
      expect(view.yMax).toBeGreaterThan(m);
    }
  });

  it('rest at 8 s by 2.00× before the round climbs', () => {
    const rest = extents(0, 1);
    expect(rest.xMaxS).toBeGreaterThan(8);
    expect(rest.xMaxS).toBeLessThan(8.6);
    expect(rest.yMax).toBeGreaterThan(2);
    expect(rest.yMax).toBeLessThan(2.3);
  });

  it('label the axes with a few nice steps', () => {
    expect(multiplierTicks(2.2)).toEqual([1.25, 1.5, 1.75, 2]);
    expect(multiplierTicks(3.4)).toEqual([1.5, 2, 2.5, 3]);
    expect(multiplierTicks(6.8)).toEqual([2, 4, 6]); // multiples of the step, not 3×, 5×
    expect(multiplierTicks(12)).toEqual([2.5, 5, 7.5, 10]);
    expect(multiplierTicks(120).every((v, i, a) => i === 0 || v > (a[i - 1] ?? 0))).toBe(true);
    expect(multiplierTicks(120).length).toBeLessThanOrEqual(5);
    expect(timeTicks(8.2)).toEqual([2, 4, 6, 8]);
    expect(timeTicks(106)).toEqual([20, 40, 60, 80, 100]);
    expect(formatTick(1.5)).toBe('1.5×');
    expect(formatTick(20)).toBe('20×');
  });
});

describe('the counter', () => {
  it.each([
    [100, '1.00×'],
    [247, '2.47×'],
    [1005, '10.05×'],
    [100_000_000, '1,000,000.00×'],
  ])('shows %d hundredths as %s — the wire’s quantisation, integer arithmetic', (h, text) => {
    expect(formatMultiplier(h)).toBe(text);
  });
});

describe('drawing', () => {
  it('draws a running round from elapsed time alone, the counter reading the curve', () => {
    const { renderer, texts } = setup();
    const drawn = renderer.draw({ kind: 'running', elapsedMs: 9_600 });
    expect(drawn).toEqual({ kind: 'running', multiplier: multiplierAt(K, 9_600) });
    expect(texts.map((t) => t.text)).toContain(formatMultiplier(multiplierAt(K, 9_600)));
  });

  it('freezes the counter red at the crash point and stops the line there', () => {
    const { renderer, texts } = setup();
    const frame: Frame = {
      kind: 'crashed',
      elapsedMs: 6_040,
      crashPoint: 247,
      sinceCrashMs: 120,
      nextInMs: 2_880,
      note: 'round #84213 · verifiable',
    };
    expect(renderer.draw(frame)).toEqual({ kind: 'crashed', multiplier: 247 });
    const counter = texts.find((t) => t.text === '2.47×');
    expect(counter?.color).toBe('#f43f5e');
    expect(texts.map((t) => t.text)).toEqual(
      expect.arrayContaining(['CRASHED', 'round #84213 · verifiable', 'next round in 2.9s']),
    );
  });

  it('counts down to the next round', () => {
    const { renderer, texts } = setup();
    renderer.draw({ kind: 'waiting', closesInMs: 3_420, bettingMs: 7_000, lastCrash: 1_318 });
    expect(texts.map((t) => t.text)).toEqual(
      expect.arrayContaining(['NEXT ROUND', '3.4s', 'last round 13.18×']),
    );
  });

  it('never hands the canvas a non-finite number, from 1.00× to the ceiling and before the start', () => {
    const { renderer } = setup();
    for (const ms of [-500, 0, 1, 67, 4621, 30_702, 92_104, 200_000])
      renderer.draw({ kind: 'running', elapsedMs: ms });
    renderer.draw({
      kind: 'crashed',
      elapsedMs: 0,
      crashPoint: 100,
      sinceCrashMs: 0,
      nextInMs: 3000,
      note: null,
    });
    renderer.draw({ kind: 'waiting', closesInMs: -50, bettingMs: 7000, lastCrash: null });
    renderer.draw({ kind: 'idle', message: 'connecting…' });
  });

  it('draws the frame at the device pixel ratio it was sized for', () => {
    const { renderer, calls } = setup();
    renderer.draw({ kind: 'idle', message: 'x' });
    expect(calls[0]).toEqual({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] });
  });
});
