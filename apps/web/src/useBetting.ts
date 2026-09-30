import type { CrashClient } from '@crash/client-core';
import type { Minor } from '@crash/money';
import type { ErrorMessage } from '@crash/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pending } from './panel.js';

/** The result moment — unmissable while the round is over, gone when the next one opens. */
export type Result =
  | {
      readonly kind: 'won';
      readonly multiplier: number;
      readonly payout: Minor;
      readonly reason: 'MANUAL' | 'AUTO';
      /** What the screen showed and what the panel predicted at the press — shown beside the result. */
      readonly press: Press | null;
    }
  | { readonly kind: 'busted'; readonly crashPoint: number }
  | { readonly kind: 'late'; readonly press: Press | null };

export interface Press {
  readonly screen: number;
  readonly predicted: number;
  readonly rtt: number | null;
}

/** Everything a cash-out tells us about the latency promise — for the C2 gate. */
export type Report =
  | { readonly kind: 'manual'; readonly press: Press; readonly actual: number }
  | { readonly kind: 'auto'; readonly target: number; readonly actual: number }
  | { readonly kind: 'late'; readonly press: Press };

const PLAYER_TEXT: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Not enough balance for that bet.',
  BET_OUT_OF_RANGE: 'That amount is outside the table limits.',
  AUTO_CASHOUT_OUT_OF_RANGE: 'That auto cash-out is outside the limits.',
  ONE_BET_PER_ROUND: 'You already have a bet in this round.',
  BETTING_CLOSED: 'Betting had already closed for that round.',
  NOT_RUNNING: 'The round has not started yet.',
  TOO_LATE: 'Too late — the round crashed before your press reached the server.',
  UNKNOWN_BET: 'That bet is no longer on the table.',
  DUPLICATE_BET_ID: 'That bet was already handled.',
};

function explain(error: ErrorMessage | null): string {
  if (error === null) return 'Disconnected before the server answered.';
  return PLAYER_TEXT[error.code] ?? error.message;
}

export function useBetting(client: CrashClient, onReport?: (report: Report) => void) {
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const press = useRef<Press | null>(null);
  const reportRef = useRef(onReport);
  useEffect(() => {
    reportRef.current = onReport;
  }, [onReport]);

  // The result moment follows the wire, not the button: an auto cash-out, or one pressed in another
  // tab, is a result too.
  useEffect(
    () =>
      client.subscribe((state, event) => {
        if (event.type !== 'message') return;
        const m = event.message;
        if (m.type === 'bettingOpen') {
          setResult(null);
          setError(null);
          press.current = null;
        } else if (m.type === 'cashOutResult') {
          const pressed = m.reason === 'MANUAL' ? press.current : null;
          setResult({
            kind: 'won',
            multiplier: m.multiplier,
            payout: m.payout,
            reason: m.reason,
            press: pressed,
          });
          if (pressed !== null)
            reportRef.current?.({ kind: 'manual', press: pressed, actual: m.multiplier });
          else if (m.reason === 'AUTO') {
            const target = state.game?.myBets.find((b) => b.betId === m.betId);
            if (target?.status === 'CASHED_OUT')
              reportRef.current?.({ kind: 'auto', target: m.multiplier, actual: m.multiplier });
          }
        } else if (m.type === 'crash') {
          const mine = state.game?.myBets[0];
          if (mine?.status === 'LOST')
            setResult((r) => r ?? { kind: 'busted', crashPoint: m.crashPoint });
        }
      }),
    [client],
  );

  const place = useCallback(
    async (stake: Minor, auto: number | null) => {
      setPending('placing');
      setError(null);
      const outcome = await client.placeBet(stake, auto);
      setPending(null);
      if (!outcome.ok) setError(explain(outcome.error));
    },
    [client],
  );

  const cancel = useCallback(
    async (betId: string) => {
      setPending('cancelling');
      setError(null);
      const outcome = await client.cancelBet(betId);
      setPending(null);
      if (!outcome.ok) setError(explain(outcome.error));
    },
    [client],
  );

  const cashOut = useCallback(
    async (betId: string) => {
      // Captured at the press: the number on screen, and the one the panel promised.
      const screen = client.multiplier();
      const predicted = client.landingMultiplier();
      if (screen !== null && predicted !== null) {
        press.current = { screen, predicted, rtt: client.getState().clock.rtt };
      }
      setPending('cashing');
      setError(null);
      const outcome = await client.cashOut(betId);
      setPending(null);
      if (!outcome.ok) {
        if (outcome.error?.code === 'TOO_LATE') {
          setResult({ kind: 'late', press: press.current });
          if (press.current !== null) reportRef.current?.({ kind: 'late', press: press.current });
        } else {
          setError(explain(outcome.error));
        }
      }
    },
    [client],
  );

  return { pending, error, result, place, cancel, cashOut };
}
