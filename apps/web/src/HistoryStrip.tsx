import type { HistoryEntry } from '@crash/protocol';
import { verifyHref } from './route.js';
import { gradeOf } from './table.js';

const x = (h: number) => `${(h / 100).toFixed(2)}×`;

/**
 * The last ~30 crash points, newest first, colour-graded. Each one is a link to the verification
 * page for that round — except a forced dev round, which has nothing to verify and says so (D13).
 */
export function HistoryStrip({ history }: { history: readonly HistoryEntry[] }) {
  if (history.length === 0) return <nav className="history" aria-label="Recent rounds" />;
  return (
    <nav className="history" aria-label="Recent rounds — pick one to verify it">
      <ol>
        {history.map((h) =>
          h.link ? (
            <li key={h.roundId}>
              <a
                className={`chip ${gradeOf(h.crashPoint)}`}
                href={verifyHref(h.link)}
                title={`Round ${h.link.chainIndex} — verify it`}
                aria-label={`Round ${h.link.chainIndex}, crashed at ${x(h.crashPoint)}. Verify it.`}
              >
                {x(h.crashPoint)}
              </a>
            </li>
          ) : (
            <li key={h.roundId}>
              <span
                className={`chip ${gradeOf(h.crashPoint)} forced`}
                title="A forced dev round — typed in, not drawn from the chain, so nothing to verify"
              >
                {x(h.crashPoint)}
              </span>
            </li>
          ),
        )}
      </ol>
    </nav>
  );
}
