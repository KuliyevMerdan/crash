import type { CrashClient } from '@crash/client-core';
import { formatMinor, payout, type Minor } from '@crash/money';
import { useEffect, useRef } from 'react';

/**
 * The centre of the game: one press, and **before** it, what the press will actually get.
 *
 * The number on the curve is where the round is on the server *now*; a press reaches the server half
 * a round trip later, so the button prices it at `landingMultiplier()` — the curve that far ahead
 * (ADR-0002). Getting a multiplier you never saw must never feel like a bug, so the button says it
 * first. Its label changes every frame, so it is written straight to the DOM from its own animation
 * frame, never through React state — a re-render of the panel sixty times a second is the first
 * thing a weak phone would drop.
 */
export function CashOutButton({
  client,
  stake,
  auto,
  enabled,
  onPress,
}: {
  client: CrashClient;
  stake: Minor;
  auto: number | null;
  enabled: boolean;
  onPress: () => void;
}) {
  const amount = useRef<HTMLSpanElement>(null);
  const detail = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let lastAmount = '';
    let lastDetail = '';
    const loop = () => {
      const landing = client.landingMultiplier();
      const rtt = client.getState().clock.rtt;
      if (landing !== null) {
        const a = formatMinor(payout(stake, landing));
        const d = `lands ≈ ${(landing / 100).toFixed(2)}× · ping ${rtt === null ? '…' : Math.round(rtt)} ms`;
        // Touch the DOM only when the text changes — most frames it does not.
        if (a !== lastAmount && amount.current) amount.current.textContent = lastAmount = a;
        if (d !== lastDetail && detail.current) detail.current.textContent = lastDetail = d;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [client, stake]);

  return (
    <button type="button" className="action cashout" disabled={!enabled} onClick={onPress}>
      <span className="action-title">CASH OUT</span>
      <span className="action-amount" ref={amount} aria-live="off">
        {formatMinor(stake)}
      </span>
      <span className="action-detail" ref={detail}>
        {auto === null ? 'press to take it' : `auto at ${(auto / 100).toFixed(2)}×`}
      </span>
    </button>
  );
}
