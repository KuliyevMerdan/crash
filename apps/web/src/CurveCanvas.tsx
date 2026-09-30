import type { CrashClient } from '@crash/client-core';
import { CrashRenderer, type Drawn } from '@crash/renderer';
import { useEffect, useRef } from 'react';
import { frameOf } from './frame.js';

/**
 * The canvas, and the only animation loop in the app. React mounts it once; after that every frame
 * is `requestAnimationFrame` → the client's state and server time → `frameOf` → the renderer. No
 * React state changes per frame — a 60 fps re-render of the shell would be the first thing to go
 * on a weak phone.
 */
export function CurveCanvas({
  client,
  onDrawn,
}: {
  client: CrashClient;
  onDrawn?: (drawn: Drawn) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !ctx) return;

    let rate = 0.15;
    const renderer = new CrashRenderer(ctx, rate);

    // The backing store at the device pixel ratio, capped at 2: past that a phone's GPU pays for
    // pixels nobody can see (fill rate is the first wall on a weak Android).
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(box.width * dpr));
      canvas.height = Math.max(1, Math.round(box.height * dpr));
      renderer.resize(box.width, box.height, dpr);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    let raf = 0;
    const loop = () => {
      const state = client.getState();
      const k = state.game?.config.curve.growthRatePerSecond;
      if (k !== undefined && k !== rate) {
        rate = k;
        renderer.setGrowthRate(k);
      }
      const drawn = renderer.draw(frameOf(state, client.serverNow()));
      onDrawn?.(drawn);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [client, onDrawn]);

  return (
    <canvas ref={ref} className="curve" role="img" aria-label="The round's multiplier curve" />
  );
}
