import { formatMinor } from '@crash/money';
import type { Result } from './useBetting.js';

const x = (h: number) => `${(h / 100).toFixed(2)}×`;

/**
 * The result moment: won at 4.21× / busted — unmissable, and gone before the next round opens.
 * A manual cash-out also shows what the screen said at the press and what the button promised, so
 * the gap between them is explained right where the player looks for it.
 */
export function ResultBanner({ result, verify }: { result: Result | null; verify: string | null }) {
  if (result === null) return null;
  if (result.kind === 'busted') {
    return (
      <div className="result lost" role="status">
        <strong>BUSTED</strong>
        <span>crashed at {x(result.crashPoint)}</span>
        {verify && (
          <a className="verify-link" href={verify}>
            check this round was fixed before you bet →
          </a>
        )}
      </div>
    );
  }
  if (result.kind === 'late') {
    return (
      <div className="result lost" role="status">
        <strong>TOO LATE</strong>
        <span>the round crashed before your press reached the server</span>
        {result.press && <small>you pressed at {x(result.press.screen)} on screen</small>}
      </div>
    );
  }
  return (
    <div className="result won" role="status">
      <strong>+{formatMinor(result.payout)}</strong>
      <span>
        {result.reason === 'AUTO' ? 'auto cash-out' : 'cashed out'} at {x(result.multiplier)}
      </span>
      {result.press && (
        <small>
          on screen {x(result.press.screen)} · promised {x(result.press.predicted)} · got{' '}
          {x(result.multiplier)}
        </small>
      )}
    </div>
  );
}
