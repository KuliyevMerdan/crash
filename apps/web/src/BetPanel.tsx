import type { CrashClient } from '@crash/client-core';
import { formatMinor, minor, type Minor } from '@crash/money';
import { useEffect, useState } from 'react';
import { CashOutButton } from './CashOutButton.js';
import { lastCallAt, panelModel, type Form } from './panel.js';
import { parseStake, stakeText } from './stake.js';
import type { useBetting } from './useBetting.js';
import { useClientState } from './useClient.js';

type Betting = ReturnType<typeof useBetting>;

/**
 * The bet panel: amount, auto cash-out, and one primary action whose meaning follows the round —
 * place, cancel, cash out — and which always says why when it cannot be pressed. Space presses it,
 * unless you are typing.
 */
export function BetPanel({ client, betting }: { client: CrashClient; betting: Betting }) {
  const state = useClientState(client);
  const [form, setForm] = useState<Form>({ stakeText: '5.00', autoOn: false, autoText: '2.00' });
  const model = panelModel(state, form, betting.pending, client.serverNow());
  useLastCall(client, lastCallAt(state));
  const config = state.game?.config;
  const balance = state.game?.player.balance;

  const primary = () => {
    if (model.mode === 'bet' && model.enabled && model.stake !== null)
      void betting.place(model.stake, model.auto);
    else if (model.mode === 'cancel' && model.enabled) void betting.cancel(model.betId);
    else if (model.mode === 'cashout' && model.enabled) void betting.cashOut(model.betId);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.code !== 'Space' ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLButtonElement
      )
        return;
      e.preventDefault();
      primary();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const step = (f: (stake: Minor) => number) => {
    const current = parseStake(form.stakeText) ?? config?.minBet ?? minor(0);
    const lo = config?.minBet ?? 100;
    const hi = Math.min(config?.maxBet ?? Infinity, balance ?? Infinity);
    const next = Math.max(lo, Math.min(hi, Math.round(f(current))));
    setForm({ ...form, stakeText: stakeText(minor(next)) });
  };
  const locked = model.mode !== 'bet';

  return (
    <section className="panel" aria-label="Bet">
      <div className="fields">
        <label className="field">
          <span>Bet</span>
          <div className="stepper">
            <button
              type="button"
              disabled={locked}
              onClick={() => step((s) => s / 2)}
              aria-label="Halve the bet"
            >
              ½
            </button>
            <input
              inputMode="decimal"
              value={form.stakeText}
              disabled={locked}
              onChange={(e) => setForm({ ...form, stakeText: e.target.value })}
              aria-describedby="panel-note"
            />
            <button
              type="button"
              disabled={locked}
              onClick={() => step((s) => s * 2)}
              aria-label="Double the bet"
            >
              ×2
            </button>
          </div>
          {config && (
            <small>
              {formatMinor(config.minBet)} – {formatMinor(config.maxBet)}
            </small>
          )}
        </label>
        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={form.autoOn}
              disabled={locked}
              onChange={(e) => setForm({ ...form, autoOn: e.target.checked })}
            />{' '}
            Auto cash-out
          </span>
          <div className="stepper">
            <input
              inputMode="decimal"
              value={form.autoText}
              disabled={locked || !form.autoOn}
              onChange={(e) => setForm({ ...form, autoText: e.target.value })}
              aria-label="Auto cash-out multiplier"
            />
            <span className="unit">×</span>
          </div>
          <small>Fires on the server at exactly this multiplier — no network in the way.</small>
        </label>
      </div>

      {model.mode === 'cashout' ? (
        <CashOutButton
          client={client}
          stake={model.stake}
          auto={model.auto}
          enabled={model.enabled}
          onPress={primary}
        />
      ) : (
        <button
          type="button"
          className={`action ${model.mode === 'cancel' ? 'cancel' : 'place'}`}
          disabled={!(model.mode === 'bet' || model.mode === 'cancel') || !model.enabled}
          onClick={primary}
        >
          <span className="action-title">
            {model.mode === 'bet' || model.mode === 'cancel'
              ? model.label
              : model.mode === 'settled'
                ? 'Cashed out'
                : 'Wait for the next round'}
          </span>
        </button>
      )}

      <p id="panel-note" className={`note ${betting.error ? 'bad' : ''}`}>
        {betting.error ??
          ('note' in model ? model.note : null) ??
          (model.mode === 'cashout' ? latencyNote(state.clock.rtt) : ' ')}
      </p>
    </section>
  );
}

function latencyNote(rtt: number | null): string {
  if (rtt === null) return 'Measuring your ping…';
  return `The server takes your press about ${Math.round(rtt / 2)} ms after you make it — the button already counts that in. Auto cash-out has no such delay.`;
}

/**
 * Re-render once at the last call: the panel is derived from the client's state, which does not
 * change when the clock passes the moment a press can no longer arrive in time — so a timer says so.
 */
function useLastCall(client: CrashClient, at: number | null): void {
  const [, setPassed] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const ms = at - client.serverNow();
    if (ms < 0) return;
    const timer = window.setTimeout(() => setPassed((n) => n + 1), ms + 1);
    return () => window.clearTimeout(timer);
  }, [client, at]);
}
