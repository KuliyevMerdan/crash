/**
 * One hand-written instance of every message in docs/protocol.md §2, copied from the document's
 * own examples wherever it has one (ROADMAP S1: "the protocol schemas parse a hand-written fixture
 * of every message"). Plain JSON-shaped objects — what actually arrives off a socket.
 */

const ROUND = '01J8ZQ4Y6T3M9N2B7C5D1E0F0A';
const BET = '01J8ZQ5A1B2C3D4E5F6G7H8J9K';
const OTHER_BET = '01J8ZQ5B9K8J7H6G5F4E3D2C1B';
const SEED = '3b1d6c0e5a7f9b2d4c6e8a0b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f';
const PREV = 'a07e2c4e6a8c0e2a4c6e8a0c2e4a6c8e0a2c4e6a8c0e2a4c6e8a0c2e4a6c8e0a';
const COMMIT = '9f2c1a3b5d7f9e1c3a5b7d9f1e3c5a7b9d1f3e5c7a9b1d3f5e7c9a1b3d5f7e9c';

export const FAIR = { chainId: 1, chainIndex: 84213, seed: SEED, previousHash: PREV };

export const CLIENT_FIXTURES = {
  authenticate: { type: 'authenticate', token: null, nick: 'merdan' },
  ping: { type: 'ping', clientTime: 1755399999000 },
  placeBet: { type: 'placeBet', betId: BET, roundId: ROUND, amount: 500, autoCashOutAt: 200 },
  cancelBet: { type: 'cancelBet', betId: BET },
  cashOut: { type: 'cashOut', betId: BET },
} as const;

export const SERVER_FIXTURES = {
  hello: {
    type: 'hello',
    token: 'tok_4f2a9c',
    serverTime: 1755400000000,
    player: { id: 'p_1', nick: 'merdan', balance: 100000 },
    config: {
      curve: { growthRatePerSecond: 0.15 },
      bettingPhaseMs: 7000,
      crashedPhaseMs: 3000,
      tickIntervalMs: 100,
      minBet: 100,
      maxBet: 50000,
      maxAutoCashOut: 100000,
      houseEdgeBps: 100,
    },
    chain: { id: 1, commit: COMMIT, salt: 'crash-demo-chain-1', length: 1000000 },
    round: {
      roundId: ROUND,
      phase: 'RUNNING',
      chainIndex: 84213,
      startedAt: 1755400007000,
      bets: [
        { betId: BET, nick: 'merdan', amount: 500, cashedOutAt: null },
        { betId: OTHER_BET, nick: 'ada', amount: 2000, cashedOutAt: 150 },
      ],
    },
    myBets: [{ roundId: ROUND, betId: BET, amount: 500, status: 'OPEN', autoCashOutAt: 200 }],
    history: [
      {
        roundId: '01J8ZQ3X0000000000000000AA',
        crashPoint: 247,
        link: { chainId: 1, chainIndex: 84212 },
      },
      { roundId: '01J8ZQ3W0000000000000000AB', crashPoint: 100, link: null },
    ],
  },
  pong: { type: 'pong', clientTime: 1755399999000, serverTime: 1755400000000 },
  bettingOpen: {
    type: 'bettingOpen',
    roundId: ROUND,
    chainIndex: 84214,
    bettingClosesAt: 1755400021600,
  },
  betAccepted: {
    type: 'betAccepted',
    roundId: ROUND,
    betId: BET,
    amount: 500,
    autoCashOutAt: 200,
    balance: 99500,
  },
  betPlaced: { type: 'betPlaced', roundId: ROUND, betId: BET, nick: 'merdan', amount: 500 },
  betCancelled: { type: 'betCancelled', roundId: ROUND, betId: BET, balance: 100000 },
  betWithdrawn: { type: 'betWithdrawn', roundId: ROUND, betId: BET },
  roundStart: { type: 'roundStart', roundId: ROUND, startedAt: 1755400028600 },
  tick: { type: 'tick', roundId: ROUND, elapsedMs: 3400, multiplier: 166 },
  cashOutResult: {
    type: 'cashOutResult',
    roundId: ROUND,
    betId: BET,
    reason: 'MANUAL',
    multiplier: 421,
    payout: 2105,
    balance: 102105,
  },
  playerCashedOut: {
    type: 'playerCashedOut',
    roundId: ROUND,
    betId: BET,
    nick: 'merdan',
    multiplier: 421,
  },
  crash: {
    type: 'crash',
    roundId: ROUND,
    crashPoint: 247,
    crashedAt: 1755400011600,
    fair: FAIR,
    settled: [
      { betId: BET, nick: 'merdan', won: true },
      { betId: OTHER_BET, nick: 'ada', won: false },
    ],
  },
  error: {
    type: 'error',
    class: 'PLAYER',
    code: 'TOO_LATE',
    message: 'the cash-out arrived after the crash',
    roundId: ROUND,
    betId: BET,
  },
} as const;

export const IDS = { ROUND, BET, OTHER_BET, COMMIT };
