import type { CrashClient } from '@crash/client-core';
import { formatMinor } from '@crash/money';
import type { Drawn } from '@crash/renderer';
import { useEffect, useState } from 'react';
import { BetPanel } from './BetPanel.js';
import { CurveCanvas } from './CurveCanvas.js';
import { ResultBanner } from './ResultBanner.js';
import { useBetting, type Report } from './useBetting.js';
import { useClientState, useDesync } from './useClient.js';

const STATUS_TEXT = {
  connecting: 'connecting…',
  authenticating: 'joining…',
  live: 'live',
  reconnecting: 'reconnecting…',
  closed: 'offline',
} as const;

export function App({
  client,
  onDrawn,
  onReport,
}: {
  client: CrashClient;
  onDrawn?: (drawn: Drawn) => void;
  onReport?: (report: Report) => void;
}) {
  const state = useClientState(client);
  const betting = useBetting(client, onReport);
  const desynced = useDesync(client);
  const announcement = useAnnouncer(client);
  const game = state.game;
  const tone = desynced ? 'bad' : state.status === 'live' ? 'good' : 'warn';

  return (
    <main className="app">
      <header className="bar">
        <span className="brand">CRASH</span>
        <span className={`pill ${tone}`} role="status">
          {desynced ? 'out of sync — resyncing' : STATUS_TEXT[state.status]}
        </span>
        {game && (
          <span className="wallet">
            <span className="nick">{game.player.nick}</span>
            <span className="balance">{formatMinor(game.player.balance)}</span>
          </span>
        )}
      </header>
      <section className="stage">
        <CurveCanvas client={client} {...(onDrawn ? { onDrawn } : {})} />
        <ResultBanner result={betting.result} />
      </section>
      <BetPanel client={client} betting={betting} />
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <footer className="notice">18+ · play money only · no real money, no payments</footer>
    </main>
  );
}

/** One sentence per phase change, for screen readers — the canvas is silent. */
function useAnnouncer(client: CrashClient): string {
  const [text, setText] = useState('');
  useEffect(
    () =>
      client.subscribe((_s, event) => {
        if (event.type !== 'message') return;
        const m = event.message;
        if (m.type === 'bettingOpen') setText('Betting is open.');
        else if (m.type === 'roundStart') setText('The round has started.');
        else if (m.type === 'crash')
          setText(`Crashed at ${(m.crashPoint / 100).toFixed(2)} times.`);
      }),
    [client],
  );
  return text;
}
