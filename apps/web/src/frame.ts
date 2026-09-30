import type { ClientState } from '@crash/client-core';
import type { Frame } from '@crash/renderer';

/**
 * The client's state at one instant, as a frame for the renderer. Pure: the same state and the same
 * server time give the same frame, which is what makes two browsers side by side agree.
 *
 * The time is `serverNow` — the client's clock plus the synced offset — never the time a tick
 * arrived. A stale view (the socket is reconnecting) keeps drawing from it: the curve goes on
 * rising, because that is what the round is doing, until a fresh `hello` or the crash says otherwise.
 */
export function frameOf(state: ClientState, serverNow: number): Frame {
  const game = state.game;
  if (game === null) {
    return {
      kind: 'idle',
      message: state.status === 'reconnecting' ? 'reconnecting…' : 'connecting…',
    };
  }
  const round = game.round;
  switch (round.phase) {
    case 'BETTING':
      return {
        kind: 'waiting',
        closesInMs: round.bettingClosesAt - serverNow,
        bettingMs: game.config.bettingPhaseMs,
        lastCrash: game.history[0]?.crashPoint ?? null,
      };
    case 'RUNNING':
      return { kind: 'running', elapsedMs: serverNow - round.startedAt };
    case 'CRASHED':
      return {
        kind: 'crashed',
        elapsedMs: round.crashedAt - round.startedAt,
        crashPoint: round.crashPoint,
        sinceCrashMs: serverNow - round.crashedAt,
        nextInMs: round.crashedAt + game.config.crashedPhaseMs - serverNow,
        note:
          round.chainIndex === null
            ? 'forced round (dev) · not verifiable'
            : `round #${round.chainIndex} · seed revealed`,
      };
  }
}
