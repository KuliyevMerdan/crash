import type { CrashClient } from '@crash/client-core';
import { formatMinor } from '@crash/money';
import type { Drawn } from '@crash/renderer';
import { useEffect, useState } from 'react';
import { BetPanel } from './BetPanel.js';
import { CurveCanvas } from './CurveCanvas.js';
import { HistoryStrip } from './HistoryStrip.js';
import { HowItWorks } from './HowItWorks.js';
import { NetworkLab } from './NetworkLab.js';
import { PlayerTable } from './PlayerTable.js';
import { ResultBanner } from './ResultBanner.js';
import { verifyHref } from './route.js';
import { useBetting, type Report } from './useBetting.js';
import { useClientState, useDesync } from './useClient.js';
import { useRoute } from './useRoute.js';
import { VerifyPage } from './VerifyPage.js';

const STATUS_TEXT = {
  connecting: 'connecting…',
  authenticating: 'joining…',
  live: 'live',
  reconnecting: 'reconnecting…',
  closed: 'offline',
} as const;

interface Props {
  client: CrashClient;
  onDrawn?: (drawn: Drawn) => void;
  onReport?: (report: Report) => void;
}

/**
 * The two screens, picked by the URL hash. The client — and its socket — outlives both: leaving the
 * table to verify a round and coming back is a re-render, not a reconnect.
 */
export function Root(props: Props) {
  const route = useRoute();
  if (route.page === 'latest') return <VerifyPage key="latest" client={props.client} latest />;
  if (route.page === 'verify') {
    const key = route.link ? `${route.link.chainId}:${route.link.chainIndex}` : 'none';
    return <VerifyPage key={key} client={props.client} link={route.link} />;
  }
  return <App {...props} />;
}

export function App({ client, onDrawn, onReport }: Props) {
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
      <HistoryStrip history={game?.history ?? []} />
      <section className="stage">
        <CurveCanvas client={client} {...(onDrawn ? { onDrawn } : {})} />
        <ResultBanner
          result={betting.result}
          verify={
            game?.round.phase === 'CRASHED' && game.round.fair ? verifyHref(game.round.fair) : null
          }
        />
      </section>
      <aside className="side">
        <BetPanel client={client} betting={betting} />
        {game && <PlayerTable game={game} />}
        <HowItWorks />
        <NetworkLab client={client} />
      </aside>
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
