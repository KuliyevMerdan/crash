import type { Minor } from '@crash/money';
import type {
  ChainInfo,
  GameConfig,
  HistoryEntry,
  MyBet,
  RoundSnapshot,
  ServerMessage,
  ServerMessageOf,
} from '@crash/protocol';

/** How many past crash points the strip keeps — the server sends ~30 in `hello` (§2.2). */
export const HISTORY_LENGTH = 30;

/**
 * Everything the client knows about the game, rebuilt from `hello` and kept current by the
 * messages after it. Every number in it came from the server; the client computes none of them —
 * not a balance, not a crash point (docs/protocol.md §1, invariant 2).
 */
export interface GameView {
  readonly player: { readonly id: string; readonly nick: string; readonly balance: Minor };
  readonly config: GameConfig;
  readonly chain: ChainInfo;
  readonly round: RoundSnapshot;
  readonly myBets: readonly MyBet[];
  readonly history: readonly HistoryEntry[];
  /**
   * Bets withdrawn this round. A `betId` is single-use (§7), so once withdrawn it can never be a
   * live bet again — which is how a `betAccepted` or `betPlaced` still in flight from before the
   * cancel is recognised as late and ignored, rather than resurrecting the bet with a stale balance.
   * The client's only bookkeeping; reset with the round.
   */
  readonly withdrawn: readonly string[];
}

export function viewFromHello(hello: ServerMessageOf<'hello'>): GameView {
  return {
    player: hello.player,
    config: hello.config,
    chain: hello.chain,
    round: hello.round,
    myBets: hello.myBets,
    history: hello.history,
    withdrawn: [],
  };
}

/**
 * One server message applied to the view. `resync` means the message does not fit what the client
 * believes — a `roundId` it does not recognise, a phase it skipped — and the answer is a fresh
 * `hello`, never a guess (§1, invariant 8).
 *
 * **Replays change nothing.** The server answers a retried `placeBet` / `cancelBet` / `cashOut` with
 * the original reply (§7), and that reply's `balance` is as old as the original. So a reply is
 * applied only the first time it changes a bet; a duplicate, or one naming a round already gone,
 * leaves the view alone.
 */
export function reduce(
  view: GameView,
  message: ServerMessage,
): { view: GameView; resync: boolean } {
  const same = { view, resync: false };
  const resync = { view, resync: true };
  const round = view.round;
  const current = 'roundId' in message && message.roundId === round.roundId;

  switch (message.type) {
    case 'hello':
      return { view: viewFromHello(message), resync: false };

    case 'pong':
    case 'error':
      return same;

    case 'bettingOpen':
      return {
        view: {
          ...view,
          round: {
            roundId: message.roundId,
            chainIndex: message.chainIndex,
            phase: 'BETTING',
            bettingClosesAt: message.bettingClosesAt,
            bets: [],
          },
          myBets: [],
          withdrawn: [],
        },
        resync: false,
      };

    case 'betPlaced': {
      if (!current) return resync;
      if (
        round.bets.some((b) => b.betId === message.betId) ||
        view.withdrawn.includes(message.betId)
      ) {
        return same;
      }
      const bet = {
        betId: message.betId,
        nick: message.nick,
        amount: message.amount,
        cashedOutAt: null,
      };
      return { view: { ...view, round: { ...round, bets: [...round.bets, bet] } }, resync: false };
    }

    case 'betWithdrawn':
      if (!current) return resync;
      return {
        view: {
          ...view,
          round: { ...round, bets: round.bets.filter((b) => b.betId !== message.betId) },
          myBets: view.myBets.filter((b) => b.betId !== message.betId),
          withdrawn: view.withdrawn.includes(message.betId)
            ? view.withdrawn
            : [...view.withdrawn, message.betId],
        },
        resync: false,
      };

    case 'betAccepted': {
      if (
        !current ||
        view.myBets.some((b) => b.betId === message.betId) ||
        view.withdrawn.includes(message.betId)
      ) {
        return same;
      }
      const bet: MyBet = {
        roundId: message.roundId,
        betId: message.betId,
        amount: message.amount,
        status: 'OPEN',
        autoCashOutAt: message.autoCashOutAt,
      };
      return {
        view: {
          ...view,
          player: { ...view.player, balance: message.balance },
          myBets: [...view.myBets, bet],
        },
        resync: false,
      };
    }

    case 'betCancelled': {
      if (!current || !view.myBets.some((b) => b.betId === message.betId)) return same;
      return {
        view: {
          ...view,
          player: { ...view.player, balance: message.balance },
          myBets: view.myBets.filter((b) => b.betId !== message.betId),
          withdrawn: view.withdrawn.includes(message.betId)
            ? view.withdrawn
            : [...view.withdrawn, message.betId],
        },
        resync: false,
      };
    }

    case 'roundStart':
      if (!current || round.phase !== 'BETTING') return resync;
      return {
        view: {
          ...view,
          round: {
            roundId: round.roundId,
            chainIndex: round.chainIndex,
            bets: round.bets,
            phase: 'RUNNING',
            startedAt: message.startedAt,
          },
        },
        resync: false,
      };

    case 'tick':
      return current && round.phase === 'RUNNING' ? same : resync;

    case 'cashOutResult': {
      const bet = view.myBets.find((b) => b.betId === message.betId);
      if (!current || bet?.status !== 'OPEN') return same;
      const settled: MyBet = {
        roundId: bet.roundId,
        betId: bet.betId,
        amount: bet.amount,
        status: 'CASHED_OUT',
        reason: message.reason,
        multiplier: message.multiplier,
        payout: message.payout,
      };
      return {
        view: {
          ...view,
          player: { ...view.player, balance: message.balance },
          myBets: view.myBets.map((b) => (b.betId === message.betId ? settled : b)),
        },
        resync: false,
      };
    }

    case 'playerCashedOut':
      if (!current) return resync;
      return {
        view: {
          ...view,
          round: {
            ...round,
            bets: round.bets.map((b) =>
              b.betId === message.betId ? { ...b, cashedOutAt: message.multiplier } : b,
            ),
          },
        },
        resync: false,
      };

    case 'crash': {
      if (!current || round.phase !== 'RUNNING') return resync;
      return {
        view: {
          ...view,
          round: {
            roundId: round.roundId,
            chainIndex: round.chainIndex,
            bets: round.bets,
            phase: 'CRASHED',
            startedAt: round.startedAt,
            crashedAt: message.crashedAt,
            crashPoint: message.crashPoint,
            fair: message.fair,
          },
          myBets: view.myBets.map((b) =>
            b.status === 'OPEN'
              ? { roundId: b.roundId, betId: b.betId, amount: b.amount, status: 'LOST' }
              : b,
          ),
          history: [
            {
              roundId: round.roundId,
              crashPoint: message.crashPoint,
              link: message.fair && {
                chainId: message.fair.chainId,
                chainIndex: message.fair.chainIndex,
              },
            },
            ...view.history,
          ].slice(0, HISTORY_LENGTH),
        },
        resync: false,
      };
    }

    default:
      return assertNever(message);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled server message: ${JSON.stringify(value)}`);
}
