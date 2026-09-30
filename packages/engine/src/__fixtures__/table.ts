import { createChain, crashPoint, type Chain } from '@crash/fair';
import { minor, type Minor } from '@crash/money';
import { serverMessage, type GameConfig, type ServerMessage } from '@crash/protocol';
import { expect } from 'vitest';
import { auditMoney, createEngine, nextDeadline, step } from '../index.js';
import type { Effect, EngineEvent, EngineState } from '../types.js';

/** The demo's config (docs/protocol.md §2.2). */
export const CONFIG: GameConfig = {
  curve: { growthRatePerSecond: 0.15 },
  bettingPhaseMs: 7000,
  crashedPhaseMs: 3000,
  tickIntervalMs: 100,
  minBet: minor(100),
  maxBet: minor(50_000),
  maxAutoCashOut: 100_000,
  houseEdgeBps: 100,
};

export const SALT = 'crash-test-chain';
const LENGTH = 20_001;
const CHAIN: Chain = createChain('5e'.repeat(32), LENGTH, { checkpointEvery: 100 });

const pointCache = new Map<number, number>();
export function crashPointAt(index: number): number {
  let point = pointCache.get(index);
  if (point === undefined) {
    point = crashPoint(CHAIN.seedAt(index), SALT, CONFIG.houseEdgeBps);
    pointCache.set(index, point);
  }
  return point;
}

/** A deterministic ULID for test object `n` — valid Crockford base32, 26 characters. */
export function ulid(prefix: 'R' | 'B', n: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let body = '';
  let value = n;
  for (let i = 0; i < 16; i += 1) {
    body = (alphabet[value % 32] ?? '0') + body;
    value = Math.floor(value / 32);
  }
  return `01J${prefix === 'R' ? '0' : '1'}000000${body}`;
}

export const amount = (n: number): Minor => minor(n);

/**
 * A table in a test: the engine's state, a clock, and the effects of the last step — with every
 * effect checked against the wire schema and the money audited after every single step.
 */
export class Table {
  state: EngineState;
  now = 0;
  last: readonly Effect[] = [];
  readonly log: Effect[] = [];
  private nextIndex = 1;
  private rounds = 0;

  constructor(config: GameConfig = CONFIG) {
    this.state = createEngine(config);
  }

  apply(event: EngineEvent, at: number = this.now): readonly Effect[] {
    this.now = at;
    const result = step(this.state, event, at);
    for (const effect of result.effects) {
      // The engine speaks the wire contract, or the contract is fiction.
      const parsed = serverMessage.safeParse(effect.message);
      if (!parsed.success)
        throw new Error(`engine emitted an invalid message: ${parsed.error.message}`);
    }
    const audit = auditMoney(result.state);
    expect(audit.accounted).toBe(audit.granted);
    this.state = result.state;
    this.last = result.effects;
    this.log.push(...result.effects);
    return result.effects;
  }

  addPlayer(playerId: string, balance = 100_000, nick = playerId): void {
    this.apply({ type: 'addPlayer', playerId, nick, balance: minor(balance) });
  }

  /** Open the next round on the chain whose crash point satisfies `want`. */
  open(
    want: (crashPoint: number) => boolean = () => true,
    at?: number,
  ): { roundId: string; crashPoint: number } {
    let index = this.nextIndex;
    while (!want(crashPointAt(index))) {
      index += 1;
      if (index >= LENGTH) throw new Error('no link in the test chain has that crash point');
    }
    this.nextIndex = index + 1;
    this.rounds += 1;
    const roundId = ulid('R', this.rounds);
    this.apply(
      {
        type: 'openRound',
        roundId,
        chain: { id: 1, salt: SALT },
        chainIndex: index,
        seed: CHAIN.seedAt(index),
        previousHash: index === 1 ? CHAIN.commit : CHAIN.seedAt(index - 1),
      },
      at ?? Math.max(this.now, nextDeadline(this.state).at),
    );
    return { roundId, crashPoint: crashPointAt(index) };
  }

  advance(to: number): readonly Effect[] {
    return this.apply({ type: 'advance' }, to);
  }

  /** Run the round to its crash via the deadlines, as the server's timer would. */
  runToCrash(): void {
    while (this.state.round?.phase !== 'CRASHED') this.advance(nextDeadline(this.state).at);
  }

  bet(
    playerId: string,
    betId: string,
    stake: number,
    autoCashOutAt: number | null = null,
    roundId?: string,
  ) {
    return this.apply({
      type: 'placeBet',
      playerId,
      betId,
      roundId: roundId ?? this.roundId(),
      amount: minor(stake),
      autoCashOutAt,
    });
  }

  cashOut(playerId: string, betId: string, at: number = this.now) {
    return this.apply({ type: 'cashOut', playerId, betId }, at);
  }

  cancel(playerId: string, betId: string) {
    return this.apply({ type: 'cancelBet', playerId, betId });
  }

  roundId(): string {
    const round = this.state.round;
    if (round === null) throw new Error('no round');
    return round.roundId;
  }

  balance(playerId: string): number {
    const player = this.state.players.get(playerId);
    if (player === undefined) throw new Error(`no player ${playerId}`);
    return player.balance;
  }

  /** The messages of the last step, by type, in order. */
  messages(type?: ServerMessage['type']): ServerMessage[] {
    return this.last.map((e) => e.message).filter((m) => type === undefined || m.type === type);
  }

  sentTo(playerId: string): ServerMessage[] {
    return this.last
      .filter((e) => e.kind === 'send' && e.playerId === playerId)
      .map((e) => e.message);
  }
}
