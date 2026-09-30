# Wire protocol

> **Status: decisions pinned, schemas not written.** This document is the contract;
> [`packages/protocol`](../packages/protocol) implements it in **S1**. When the two disagree, this
> file is wrong and gets fixed in the same change as the code — never the other way round.
>
> Transport is a single **WebSocket** per client. There is no HTTP game API: every game message
> flows over the socket, in both directions, because the round is a broadcast and polling a
> broadcast is a category error. HTTP exists only for health, static assets, and the verification
> page's chain lookup (§10).

## 1. Invariants

These hold for every message in both directions. A change to any of them is an ADR, not an edit.

1. **The server owns the clock.** Every timestamp on the wire is server milliseconds since epoch.
   Clients never send a time expecting it to be trusted for anything but latency measurement (§8).
2. **The server owns the money.** The client never computes a balance. Every message that moves
   money carries the authoritative balance after the operation it describes.
3. **Money is integer minor units** (`Minor`), on both sides of the wire. No floats, no decimal
   strings, no client-side rounding.
4. **The multiplier is a pure function of round time**, defined once in
   [`packages/curve`](../packages/curve) and shipped to both sides. The server broadcasts ticks so
   clients can correct drift; it does not broadcast them so clients can learn the multiplier.
5. **The crash point is decided before betting opens and revealed only at crash**
   ([ADR-0001](adr/ADR-0001-committed-crash-point.md)). It appears in exactly one message: `crash`.
6. **`betId` is client-generated** and is the idempotency key. A retry after a timeout is provably
   the same bet (§7).
7. **Cash-out resolves on server receive time** ([ADR-0002](adr/ADR-0002-server-time-cashout.md)).
8. **Every server message carries `roundId`** except `hello`, `pong` and connection-level errors.
   A client that receives a `roundId` it doesn't recognise re-syncs via `hello` rather than guessing.
9. **Unknown fields are ignored, unknown message types are logged and dropped.** Neither side
   disconnects on a message it doesn't understand.

## 2. Messages

`c→s` client to server · `s→c` server to client. Every message is
`{ type: string, ...payload }`, JSON, one message per frame.

| Type | Dir | When |
| --- | --- | --- |
| `authenticate` | c→s | first message on the socket |
| `hello` | s→c | reply to `authenticate` — the full snapshot |
| `ping` / `pong` | c↔s | clock sync + liveness (§8) |
| `bettingOpen` | s→c | a new round accepts bets |
| `placeBet` | c→s | during `BETTING` only |
| `betAccepted` / `betRejected` | s→c | to the bettor |
| `betPlaced` | s→c | broadcast — someone bet |
| `cancelBet` | c→s | during `BETTING` only |
| `roundStart` | s→c | betting closed, multiplier running |
| `tick` | s→c | ~every 100 ms during `RUNNING` |
| `cashOut` | c→s | during `RUNNING` only |
| `cashOutResult` | s→c | to the presser |
| `playerCashedOut` | s→c | broadcast — someone got out |
| `crash` | s→c | round over, seed revealed |
| `error` | s→c | anything rejected (§6) |

### 2.1 `authenticate` (c→s)

```jsonc
{ "type": "authenticate", "token": "…" | null, "nick": "merdan" }
```

`token` null on a first visit — the server issues one in `hello` and the client persists it. This is
a play-money demo: the token identifies a wallet, it is not a security boundary.

### 2.2 `hello` (s→c)

The complete snapshot. **A reconnecting client needs nothing else** — this is the crash analogue of
the slot's `pendingRound`, and it is why resume is a two-line problem here rather than a block.

```jsonc
{
  "type": "hello",
  "token": "…",
  "serverTime": 1755400000000,
  "player": { "id": "…", "nick": "merdan", "balance": 100000 },
  "config": {
    "curve": { "growthRatePerSecond": 0.15 },   // §3 — clients MUST NOT hardcode this
    "bettingPhaseMs": 7000,
    "tickIntervalMs": 100,
    "minBet": 100, "maxBet": 50000,
    "maxAutoCashOut": 100000,                    // 1000.00×, in hundredths
    "houseEdgeBps": 100
  },
  "chain": { "commit": "sha256:…", "index": 84213 },
  "round": { /* §2.3 */ },
  "myBets": [ /* §2.5, this round only */ ],
  "history": [ { "roundId": "…", "crashPoint": 247 }, … ]   // last ~30, for the sparkline
}
```

### 2.3 Round snapshot

```jsonc
{
  "roundId": "01J…",              // ULID, server-generated
  "phase": "BETTING" | "RUNNING" | "CRASHED",
  "bettingClosesAt": 1755400007000,   // BETTING only
  "startedAt": 1755400007000,         // RUNNING and CRASHED
  "crashedAt": 1755400011600,         // CRASHED only
  "crashPoint": 247,                  // CRASHED only — hundredths, 2.47×
  "bets": [ /* §2.6 — everyone's, for the side panel */ ]
}
```

**Multipliers on the wire are integers in hundredths of 1×** — `100` is `1.00×`, `247` is `2.47×`. Same reason
money is minor units: `2.47` is not representable, and a payout must not depend on how a runtime
rounds it.

### 2.4 `placeBet` (c→s)

```jsonc
{ "type": "placeBet", "betId": "01J…", "roundId": "01J…", "amount": 500, "autoCashOutAt": 200 | null }
```

`betId` is a client-generated ULID (§7). `roundId` is echoed so a bet placed as the phase flips is
rejected rather than silently applied to the next round.

Replies `betAccepted { betId, balance }` or an `error` (§6). Broadcast `betPlaced { roundId, betId,
nick, amount }` — **`amount` only; `autoCashOutAt` is never broadcast.** It is a player's strategy
and leaking it lets others read the table.

### 2.5 `cashOut` (c→s) and `cashOutResult` (s→c)

```jsonc
{ "type": "cashOut", "betId": "01J…" }
```

No multiplier, no timestamp: the client has nothing to say that the server would believe
([ADR-0002](adr/ADR-0002-server-time-cashout.md)).

```jsonc
{ "type": "cashOutResult", "betId": "01J…", "multiplier": 421, "payout": 2105, "balance": 102105 }
```

Broadcast `playerCashedOut { roundId, betId, nick, multiplier }` — no payout, no balance. Stakes are
public (they're on the table), balances are not.

A server-side auto cash-out produces exactly the same two messages, with
`"reason": "AUTO"` on the result. The client must not special-case it: an auto cash-out that
rendered differently from a manual one would be a lie about which one fired.

### 2.6 `tick` (s→c)

```jsonc
{ "type": "tick", "roundId": "01J…", "elapsedMs": 3400, "multiplier": 167 }
```

The client renders from `curve(now − startedAt)` and uses `tick` to **correct drift**, not to drive
animation — a client that only redraws on tick renders at 10 fps. `multiplier` is redundant with
`elapsedMs` by construction and is sent anyway, as an assertion: a mismatch beyond one step (0.01×)
means the two sides disagree about the curve, which is a loud dev-build error (§9).

### 2.7 `crash` (s→c)

```jsonc
{
  "type": "crash",
  "roundId": "01J…",
  "crashPoint": 247,
  "crashedAt": 1755400011600,
  "fair": { "seed": "…", "chainIndex": 84213, "previousHash": "sha256:…" },
  "settled": [ { "betId": "…", "nick": "…", "won": false } , … ],
  "balance": 99500
}
```

`fair` is the reveal, and it is the only message it ever appears in. `previousHash` is the seed of
the round before, so a client can verify the chain link without a round trip.

## 3. The curve

```
m(t) = max(100, floor(100 · e^(k · t)))        // hundredths of 1×, t in seconds
t(m) = ln(m / 100) / k                          // the inverse — auto cash-out, cash-out resolution
```

`k = growthRatePerSecond`, delivered in `hello.config` and **never hardcoded in a client**. With
`k = 0.15`: `2×` at ≈4.6 s, `10×` at ≈15.4 s, `100×` at ≈30.7 s.

Both directions live in [`packages/curve`](../packages/curve) and are used by the server to resolve
money and by the client to draw. One implementation, imported twice — the moment there are two, they
drift, and the drift is a payout bug that only appears under load.

## 4. Round lifecycle

```
BETTING ──(bettingClosesAt)──▶ RUNNING ──(m reaches crashPoint)──▶ CRASHED ──(pause)──▶ BETTING
   │                              │                                    │
placeBet                       cashOut                            seed revealed
cancelBet                    auto cash-out fires                  bets settled
```

The crash point is drawn from the chain **when `BETTING` opens**, before any bet exists, and held
server-side until the reveal. `RUNNING` ends at a moment computed once, at round start, as
`startedAt + t(crashPoint)·1000` — the server does not poll the curve to decide when to bust.

## 5. Recovery

There is no recovery call. `authenticate` → `hello` carries `round` and `myBets`, and the client
reconstructs from that:

| Reconnect during | Client does |
| --- | --- |
| `BETTING` | render the countdown from `bettingClosesAt`; restore any bet in `myBets` |
| `RUNNING` | resume the curve from `startedAt` — the multiplier is a function of time, so there is nothing to catch up on |
| `CRASHED` | show the result screen for the remaining pause |

An open bet that the player cashed out while disconnected is already resolved in `myBets` — the
money moved on the server, and a disconnect never costs a settled win.

## 6. Errors

Three classes, exactly as in the slot project, because the client's *reaction* differs per class and
nothing else about an error matters to it.

```jsonc
{ "type": "error", "class": "PLAYER" | "SESSION" | "SYSTEM", "code": "…", "message": "…", "betId": "…"? }
```

| Class | Meaning | Client reaction |
| --- | --- | --- |
| `PLAYER` | You did something the rules disallow — `INSUFFICIENT_FUNDS`, `BET_OUT_OF_RANGE`, `BETTING_CLOSED`, `TOO_LATE` (the cash-out lost the race), `DUPLICATE_BET_ID` | Show it, stay connected, next round is fine |
| `SESSION` | Token invalid or expired | Re-`authenticate`, then resume |
| `SYSTEM` | Server fault | Retry with backoff; never re-issue a bet under a new `betId` |

`TOO_LATE` is a `PLAYER` error and not a special case: the press was legal, it just lost.

## 7. Idempotency

`betId` is generated by the client before the bet is sent, and it keys everything about that bet for
its lifetime.

- `placeBet` with a `betId` the server has seen **replays the original `betAccepted`** — it never
  places a second bet. This is what makes retrying after a timeout safe.
- `cashOut` with a `betId` already resolved replays the original `cashOutResult`, with the original
  multiplier. A retry cannot improve or destroy a resolution.
- A `betId` from a previous round is `DUPLICATE_BET_ID`, not a fresh bet.

The client generates a new `betId` per *intent to bet*, not per *send*. Reusing one across a retry is
the whole point; reusing one across two intentional bets is a bug the server catches.

## 8. Clock sync and liveness

```jsonc
c→s  { "type": "ping", "clientTime": 1755399999000 }
s→c  { "type": "pong", "clientTime": 1755399999000, "serverTime": 1755400000000 }
```

`offset = serverTime − (sent + received) / 2`, `rtt = received − sent`. The client keeps the
**median of the last 5** samples, re-samples every 30 s, and uses:

- `offset` to place `startedAt` on its own timeline, so the curve is drawn correctly;
- `rtt` to tell the player what their manual press will actually land on
  ([ADR-0002](adr/ADR-0002-server-time-cashout.md)).

Neither value is ever sent back to the server or used in a money calculation. `ping` doubles as the
liveness check: no `pong` for 3 intervals and the client reconnects.

## 9. Environment & dev flags

- `__ASSERT_CURVE__` (dev builds) — compare each `tick.multiplier` against the locally computed one
  and throw on a mismatch over one step (0.01×). Catches curve drift the moment it appears.
- `forceCrashPoint` — dev-mode only, **gated on the server**, with a test that a production-mode
  server rejects a hand-crafted message carrying it. The stripped client cannot send it, so nothing
  else would catch a regression there.
- Fault injection (latency, drop, disconnect) is server-side and toggled from the debug panel, so a
  reviewer can watch the client survive a bad network on the live demo.

## 10. Deliberately not in v1

- **Chat, tipping, avatars.** Social panel is the bet list, nothing more.
- **Multiple simultaneous bets per round.** Every crash game has two bet panels; it is duplicated UI
  over the same protocol and adds nothing to read.
- **Real money, deposits, withdrawals, KYC.** Play money only, permanently.
- **A second game mode.** One round type, finished.
- **Binary framing / protobuf.** JSON at 10 messages/second/client is not the bottleneck, and
  readable frames in devtools are worth more here than bytes.

Chain lookup for the verification page is the one HTTP endpoint: `GET /fair/:chainIndex` returns
`{ seed, previousHash, crashPoint }` for a past round, so a player can verify without a socket.

## 11. Decision log

Each entry is a question that was open, the answer, and the alternative that lost.

**D1 — Does the client send its multiplier on cash-out?** No. Server receive time decides. Rejected:
client-reported multiplier (free money), client timestamp via clock offset (turns §8 into an attack
surface). → [ADR-0002](adr/ADR-0002-server-time-cashout.md)

**D2 — Are ticks the source of the multiplier, or a correction?** A correction. The curve is a pure
function of time and both sides ship it. Rejected: tick-driven rendering (10 fps or interpolation
with no ground truth), client-side curve with no ticks at all (drift with nothing to catch it).

**D3 — Multipliers on the wire: float or integer?** Integer hundredths of 1×. Same argument as minor
units for money. Rejected: `2.47` as a number (not representable, and it multiplies a balance).

**D4 — Is `autoCashOutAt` broadcast?** No. Stakes are public, strategy is private. Rejected:
broadcasting everything for a richer side panel — it lets players read each other.

**D5 — Where does the crash moment come from during `RUNNING`?** Computed once at round start via
`t(crashPoint)`, then scheduled. Rejected: checking the curve every tick — same result, but it makes
the bust time a function of tick jitter and server load.

**D6 — Recovery call, or snapshot in `hello`?** Snapshot. A crash round is public state; there is
nothing private to reconcile, so a separate call would be ceremony. Rejected: the slot project's
`pendingRound` shape (it solves a problem — a private in-flight round — that does not exist here).

**D7 — One socket or socket + HTTP for actions?** One socket. Bets and cash-outs are ordered against
a broadcast clock; sending them down a second, independently-queued channel would create ordering
questions with no upside. HTTP keeps health, assets and `/fair/:index`.
