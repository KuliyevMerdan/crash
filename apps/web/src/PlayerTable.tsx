import type { GameView } from '@crash/client-core';
import { formatMinor } from '@crash/money';
import { tableModel } from './table.js';

const x = (h: number) => `${(h / 100).toFixed(2)}×`;

/**
 * The live player list: nick, stake, and the multiplier each one got, filling in as they cash out.
 * React renders it on the messages that change the table — a bet, a withdrawal, a cash-out, the
 * crash — and never per tick (the view object does not change on a tick).
 */
export function PlayerTable({ game }: { game: GameView }) {
  const model = tableModel(game);
  return (
    <section className="players" aria-label="Players this round">
      <header className="players-head">
        <span>
          <strong>{model.players}</strong> {model.players === 1 ? 'player' : 'players'}
        </span>
        <span>
          <strong>{formatMinor(model.staked)}</strong> staked
        </span>
        <span>
          <strong>{model.cashedOut}</strong> out
        </span>
      </header>
      {model.rows.length === 0 ? (
        <p className="players-empty">No bets on the table yet.</p>
      ) : (
        <ol className="players-list">
          {model.rows.map((row) => (
            <li key={row.betId} className={`player ${row.state}${row.mine ? ' mine' : ''}`}>
              <span className="who">
                {row.nick}
                {row.mine && <em> · you</em>}
              </span>
              <span className="stake">{formatMinor(row.amount)}</span>
              <span className="got">
                {row.state === 'cashed' && row.multiplier !== null && row.won !== null
                  ? `${x(row.multiplier)} · +${formatMinor(row.won)}`
                  : row.state === 'lost'
                    ? 'lost'
                    : '—'}
              </span>
            </li>
          ))}
        </ol>
      )}
      {model.hidden > 0 && <p className="players-more">and {model.hidden} more</p>}
    </section>
  );
}
