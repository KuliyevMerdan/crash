# Wire protocol

> **Status: pinned and implemented.** This document is the contract;
> [`packages/protocol`](../packages/protocol) implements it (**S1**, 2026-09-30) — a zod schema for
> every message below, parsed at the boundary on both sides. When the two disagree, this
> file is wrong and gets fixed in the same change as the code — never the other way round.
>
> Transport is a single **WebSocket** per client. There is no HTTP game API: every game message
> flows over the socket, in both directions, because the round is a broadcast and polling a
> broadcast is a category error. HTTP exists only for health, static assets, and the verification
> page's chain lookup (§3.3).

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
   ([ADR-0001](adr/ADR-0001-committed-crash-point.md)). It first appears in `crash`; after that it
   is public history — the `CRASHED` snapshot, `hello.history`, `GET /fair/…` — and before it,
   nowhere. (The earlier wording, "exactly one message", was already contradicted by
   `hello.history`; the invariant is *when*, not *where*.)
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

Money moves through three verbs — place, cancel, cash out — and each has the same two-message shape:
a **private reply to the actor** carrying the authoritative `balance`, and a **public broadcast**
carrying only what the table may see. No broadcast ever carries a balance or an `autoCashOutAt`.

| Type | Dir | When |
| --- | --- | --- |
| `authenticate` | c→s | first message on the socket |
| `hello` | s→c | reply to `authenticate` — the full snapshot |
| `ping` / `pong` | c↔s | clock sync + liveness (§8) |
| `bettingOpen` | s→c | broadcast — a new round accepts bets (§2.8) |
| `placeBet` | c→s | during `BETTING` only |
| `betAccepted` | s→c | to the bettor |
| `betPlaced` | s→c | broadcast — someone bet |
| `cancelBet` | c→s | during `BETTING` only (§2.9) |
| `betCancelled` | s→c | to the canceller |
| `betWithdrawn` | s→c | broadcast — someone took their bet back |
| `roundStart` | s→c | broadcast — betting closed, multiplier running (§2.8) |
| `tick` | s→c | ~every 100 ms during `RUNNING` |
| `cashOut` | c→s | during `RUNNING` only |
| `cashOutResult` | s→c | to the presser — or to the owner of a bet an auto cash-out closed |
| `playerCashedOut` | s→c | broadcast — someone got out |
| `crash` | s→c | broadcast — round over, seed revealed |
| `error` | s→c | anything refused (§6) — including a refused bet; there is no `betRejected` |

Identifiers (`roundId`, `betId`) are ULIDs — 26 characters of Crockford base32. Timestamps are
server epoch milliseconds, integers. Seeds and hashes are 64 lowercase hex characters, no prefix.

### 2.1 `authenticate` (c→s)

```jsonc
{ "type": "authenticate", "token": "…" | null, "nick": "merdan" }
```

`token` null on a first visit — the server issues one in `hello` and the client persists it. This is
a play-money demo: the token identifies a wallet, it is not a security boundary. `nick` is 1–16
characters after trimming and is (re)applied on every `authenticate`.

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
    "curve": { "growthRatePerSecond": 0.15 },   // §3.1 — clients MUST NOT hardcode this
    "bettingPhaseMs": 7000,
    "crashedPhaseMs": 3000,                     // the pause between the crash and the next bettingOpen
    "tickIntervalMs": 100,
    "minBet": 100, "maxBet": 50000,
    "maxAutoCashOut": 100000,                    // 1000.00×, in hundredths
    "houseEdgeBps": 100
  },
  "chain": { "id": 1, "commit": "9f2c…", "salt": "crash-demo-chain-1", "length": 1000000 },  // §3.3
  "round": { /* §2.3 */ },
  "myBets": [ /* §2.10 — my bets in this round only */ ],
  "history": [ { "roundId": "…", "crashPoint": 247 }, … ]   // last ~30, newest first
}
```

`houseEdgeBps` is a true basis-point figure — `100` is 1% — and it is the one field on the wire that
is. It parameterises the crash-point function (§3.2); it is sent so the verification page can
recompute a result without a second source of truth.

### 2.3 Round snapshot

A discriminated union on `phase`. Each variant carries exactly the fields that are true in it.

```jsonc
// BETTING
{ "roundId": "01J…", "phase": "BETTING", "chainIndex": 84213,
  "bettingClosesAt": 1755400007000, "bets": [ /* §2.10 public entries */ ] }

// RUNNING
{ "roundId": "01J…", "phase": "RUNNING", "chainIndex": 84213,
  "startedAt": 1755400007000, "bets": [ … ] }

// CRASHED
{ "roundId": "01J…", "phase": "CRASHED", "chainIndex": 84213,
  "startedAt": 1755400007000, "crashedAt": 1755400011600,
  "crashPoint": 247,                            // hundredths, 2.47×
  "fair": { /* §2.7 — revealed, so it may appear here */ },
  "bets": [ … ] }
```

**Multipliers on the wire are integers in hundredths of 1×** — `100` is `1.00×`, `247` is `2.47×`,
and none exceeds `100000000` (`1,000,000.00×`, §3.2). Same reason money is minor units: `2.47` is
not representable, and a payout must not depend on how a runtime rounds it.

`chainIndex` is the round's position in the chain (§3.3) — public from `bettingOpen` on, because
knowing *which* link a round will reveal says nothing about *what* it contains.

### 2.4 `placeBet` (c→s)

```jsonc
{ "type": "placeBet", "betId": "01J…", "roundId": "01J…", "amount": 500, "autoCashOutAt": 200 | null }
```

`betId` is a client-generated ULID (§7). `roundId` is echoed so a bet placed as the phase flips is
rejected (`BETTING_CLOSED`) rather than silently applied to the next round. One bet per player per
round (§10); `autoCashOutAt`, when present, is between `101` and `config.maxAutoCashOut`.

```jsonc
{ "type": "betAccepted", "roundId": "01J…", "betId": "01J…", "amount": 500, "autoCashOutAt": 200, "balance": 99500 }
```

Broadcast `betPlaced { roundId, betId, nick, amount }` — **`amount` only; `autoCashOutAt` is never
broadcast.** It is a player's strategy and leaking it lets others read the table.

### 2.5 `cashOut` (c→s) and `cashOutResult` (s→c)

```jsonc
{ "type": "cashOut", "betId": "01J…" }
```

No multiplier, no timestamp: the client has nothing to say that the server would believe
([ADR-0002](adr/ADR-0002-server-time-cashout.md)).

```jsonc
{ "type": "cashOutResult", "roundId": "01J…", "betId": "01J…", "reason": "MANUAL" | "AUTO",
  "multiplier": 421, "payout": 2105, "balance": 102105 }
```

`payout` is `floor(amount × multiplier / 100)` — here `floor(500 × 421 / 100) = 2105`. Broadcast
`playerCashedOut { roundId, betId, nick, multiplier }` — no payout, no balance. Stakes are public
(they're on the table), balances are not.

A server-side auto cash-out produces exactly the same two messages; `reason` is the only difference,
and it is always present. The client must not otherwise special-case it: an auto cash-out that
rendered differently from a manual one would be a lie about which one fired.

### 2.6 `tick` (s→c)

```jsonc
{ "type": "tick", "roundId": "01J…", "elapsedMs": 3400, "multiplier": 166 }
```

The client renders from `m(now − startedAt)` and uses `tick` to **correct drift**, not to drive
animation — a client that only redraws on tick renders at 10 fps. `multiplier` is redundant with
`elapsedMs` by construction (`m(3400) = 166` at `k = 0.15`) and is sent anyway, as an assertion: a
mismatch beyond one step (0.01×) means the two sides disagree about the curve, which is a loud
dev-build error (§9).

### 2.7 `crash` (s→c)

```jsonc
{
  "type": "crash",
  "roundId": "01J…",
  "crashPoint": 247,
  "crashedAt": 1755400011600,
  "fair": { "chainId": 1, "chainIndex": 84213, "seed": "3b1d…", "previousHash": "a07e…" },
  "settled": [ { "betId": "…", "nick": "…", "won": false } , … ]
}
```

`fair` is the reveal, and it appears in `crash`, in a `CRASHED` snapshot, and from
`GET /fair/:chainId/:chainIndex` — never before the crash. `previousHash` is the seed of the round
before (the chain commit, for `chainIndex` 1), so a client verifies the link as
`SHA256(seed) = previousHash` without a round trip (§3.3). `settled` lists every bet in the round
with whether it won; the money for a win already moved at its `cashOutResult`, and a loss moves
nothing, so `crash` carries no balance.

### 2.8 `bettingOpen` and `roundStart` (s→c)

```jsonc
{ "type": "bettingOpen", "roundId": "01J…", "chainIndex": 84214, "bettingClosesAt": 1755400021600 }
{ "type": "roundStart",  "roundId": "01J…", "startedAt": 1755400028600 }
```

`bettingOpen` begins a round with an empty table: the client's snapshot becomes the `BETTING` variant
with `bets: []`. `roundStart` flips it to `RUNNING`; `startedAt` is the only thing the client needs
to draw every frame that follows.

### 2.9 `cancelBet` (c→s)

```jsonc
{ "type": "cancelBet", "betId": "01J…" }
```

Replies `betCancelled { roundId, betId, balance }` to the canceller and broadcasts
`betWithdrawn { roundId, betId }`. Only during `BETTING`; afterwards it is `BETTING_CLOSED`. A
`betId` the player never placed is `UNKNOWN_BET`.

### 2.10 Bet entries

Two shapes, because two audiences. **Public** — `round.bets`, what the side panel shows:

```jsonc
{ "betId": "01J…", "nick": "merdan", "amount": 500, "cashedOutAt": 421 | null }
```

`cashedOutAt` fills in as the player gets out; `null` while the bet rides or once it lost.

**Private** — `hello.myBets`, the reconnecting player's own bets in the current round, a
discriminated union on `status`:

```jsonc
{ "roundId": "01J…", "betId": "01J…", "amount": 500, "status": "OPEN",       "autoCashOutAt": 200 | null }
{ "roundId": "01J…", "betId": "01J…", "amount": 500, "status": "CASHED_OUT", "reason": "MANUAL" | "AUTO",
  "multiplier": 421, "payout": 2105 }
{ "roundId": "01J…", "betId": "01J…", "amount": 500, "status": "LOST" }
```

A cancelled bet is gone from both lists — it never happened, and its money is back.

## 3. The curve, the crash point and the chain

### 3.1 The curve

```
m(ms) = min(MAX, max(100, floor(100 · e^(k · ms / 1000))))   // hundredths of 1×, ms since startedAt
t(x)  = the least integer ms with m(ms) ≥ x                   // the inverse: crash moment, auto cash-out
```

`k = growthRatePerSecond`, delivered in `hello.config` and **never hardcoded in a client**. With
`k = 0.15`: `2×` at ≈4.6 s, `10×` at ≈15.4 s, `100×` at ≈30.7 s. `MAX` is `100000000` (§3.2).

Time on the curve is **integer milliseconds**, and the inverse is defined by the forward function
rather than by `ln` alone: `t(x)` is the first millisecond at which `m` shows at least `x`. That
makes the two agree exactly, so the moment the server busts at `t(crashPoint)` is the first moment
the curve reads `crashPoint`, never one millisecond either side because of a rounded logarithm.

Both directions live in [`packages/curve`](../packages/curve) and are used by the server to resolve
money and by the client to draw. One implementation, imported twice — the moment there are two, they
drift, and the drift is a payout bug that only appears under load. `Math.exp` is exact to the last
bit only within one JavaScript engine; a browser on another engine may disagree with the server by
one step at a boundary, which is what the one-step tolerance in §2.6 and §9 is for. The server's
number is the only one that pays.

### 3.2 The crash point

A pure function of the round's seed, the chain's salt and the house edge
([ADR-0001](adr/ADR-0001-committed-crash-point.md)), implemented once in
[`packages/fair`](../packages/fair):

```
h = HMAC_SHA256(key = bytes(seed), message = utf8(salt))
r = the first 52 bits of h, as an integer               // 0 ≤ r < 2^52
crashPoint = min(MAX, max(100, floor((10000 − houseEdgeBps) · 2^52 / (100 · (2^52 − r)))))
```

Computed in integer (`BigInt`) arithmetic — no float touches it. With `X = r / 2^52` uniform on
`[0, 1)` and `E = houseEdgeBps / 10000`, the unclamped multiplier is `(1 − E) / (1 − X)`, so

- `P(crash ≥ m) = (1 − E) / m` for every `m ≥ 1.00×` the clamp leaves alone — `0.99 / m` at 1%;
- the rounds that bust instantly at `1.00×` are exactly the `E` fraction with `X < E`;
- **every cash-out target has the same expected return, `1 − E`** — a player at `1.5×` and a player
  at `10×` pay the same edge. The edge is in the distribution, not a fee and not a thumb on the
  scale.

`tools/sim` asserts all three empirically over millions of rounds (**S4**); the derivation is here so
that a failure there is a bug to find, not a constant to tune.

`MAX = 100000000` (`1,000,000.00×`) keeps every multiplier and every payout a safe integer in
JavaScript. It costs the edge nothing anyone can collect: auto cash-out stops at
`config.maxAutoCashOut`, and a manual press above a million times the stake would need a round of
≈92 s at `k = 0.15` that arrives once in about a million.

### 3.3 The chain

The server generates a chain off-line — `s₀` 32 random bytes from a CSPRNG, `sᵢ₊₁ = SHA256(sᵢ)`
over the raw bytes — and publishes its **commit** `s_{N−1}` with the chain's `id`, `salt` and
`length = N` before the first round that uses it. Round `j` (its `chainIndex`, `1 ≤ j ≤ N − 1`) uses
seed `s_{N−1−j}`. Each revealed seed therefore hashes to the one revealed before it, and `j` hashes
walk any seed back to the commit:

```
SHA256(seed_j) = seed_{j−1}          // seed_0 is the commit
SHA256^j(seed_j) = commit            // what the verification page does, in the browser
```

- **Length:** `N = 1,000,000` — at ~20 s a round, about seven months of continuous play. Generating
  it is a million hashes, once; the server keeps checkpoints so any seed is a bounded walk away.
- **Rotation:** chains are numbered from `1`. When a chain has **50,000** rounds left (~11 days), the
  next one is generated and its `{ id, commit, salt, length }` published at `GET /fair/chains`; the
  first round after index `N − 1` opens on the next chain at index `1`. Nothing about a round in
  flight changes at a rotation.
- **Salt:** a public string fixed with the commit (`crash-demo-chain-1`). A real-money operator would
  take the salt from a public randomness beacon published *after* the commit, so it could not grind
  `s₀` for a chain it liked; for a play-money demo the fixed salt is recorded as the gap it is.
- **Never regenerate.** `s₀` is the chain; the server only ever needs `s₀` and the consumed index.
  A restart resumes at the next unconsumed index. A new `s₀` for a published commit would silently
  break every past verification.

The one HTTP surface of the game, for the verification page and anyone with `curl`:

| Endpoint | Returns |
| --- | --- |
| `GET /fair/chains` | every chain: `{ id, commit, salt, length, houseEdgeBps }`, including a published next one |
| `GET /fair/:chainId/:chainIndex` | a **revealed** round: `{ chainId, chainIndex, seed, previousHash, crashPoint, roundId }`; an index not yet revealed is `404` — never the seed |

## 4. Round lifecycle

```
BETTING ──(bettingClosesAt)──▶ RUNNING ──(m reaches crashPoint)──▶ CRASHED ──(pause)──▶ BETTING
   │                              │                                    │
placeBet                       cashOut                            seed revealed
cancelBet                    auto cash-out fires                  bets settled
```

The crash point is drawn from the chain **when `BETTING` opens**, before any bet exists, and held
server-side until the reveal. `RUNNING` ends at a moment computed once, at round start, as
`startedAt + t(crashPoint)` (§3.1, integer ms) — the server does not poll the curve to decide when
to bust. A round whose crash point is `100` busts at `startedAt` itself: `RUNNING` exists for zero
milliseconds, and no press can beat it. `CRASHED` lasts `config.crashedPhaseMs`, then the next
`bettingOpen`.

Auto cash-outs fire at `startedAt + t(autoCashOutAt)`. One that lands at or after the crash moment
does not fire — the curve never showed that multiplier. At the same millisecond, the crash wins: a
cash-out is worth `m(receivedAt − startedAt)` only while `receivedAt < startedAt + t(crashPoint)`.

## 5. Recovery

There is no recovery call. `authenticate` → `hello` carries `round` and `myBets`, and the client
reconstructs from that:

| Reconnect during | Client does |
| --- | --- |
| `BETTING` | render the countdown from `bettingClosesAt`; restore any bet in `myBets` |
| `RUNNING` | resume the curve from `startedAt` — the multiplier is a function of time, so there is nothing to catch up on |
| `CRASHED` | show the result screen until `crashedAt + config.crashedPhaseMs` |

An open bet that the player cashed out while disconnected is already resolved in `myBets` — the
money moved on the server, and a disconnect never costs a settled win.

## 6. Errors

Three classes, exactly as in the slot project, because the client's *reaction* differs per class and
nothing else about an error matters to it.

```jsonc
{ "type": "error", "class": "PLAYER" | "SESSION" | "SYSTEM", "code": "…", "message": "…",
  "roundId": "…"?, "betId": "…"? }
```

`roundId` and `betId` are present when the refusal is about a bet; an error about the connection
itself carries neither (§1, invariant 8). **The class is a function of the code** — one table, in
`packages/protocol`, and a message whose class disagrees with its code fails to parse.

| Class | Codes | Client reaction |
| --- | --- | --- |
| `PLAYER` | `INSUFFICIENT_FUNDS` · `BET_OUT_OF_RANGE` · `AUTO_CASHOUT_OUT_OF_RANGE` · `ONE_BET_PER_ROUND` · `BETTING_CLOSED` · `NOT_RUNNING` (a cash-out before `roundStart`) · `TOO_LATE` (the cash-out lost the race) · `DUPLICATE_BET_ID` · `UNKNOWN_BET` · `MALFORMED_MESSAGE` | Show it, stay connected, next round is fine |
| `SESSION` | `SESSION_INVALID` (token unknown or expired) · `NOT_AUTHENTICATED` (a game message before `authenticate`) | Re-`authenticate`, then resume |
| `SYSTEM` | `INTERNAL` · `UNAVAILABLE` | Retry with backoff; never re-issue a bet under a new `betId` |

`MALFORMED_MESSAGE` is a known `type` whose payload fails its schema — a client bug, answered rather
than swallowed so it is visible in devtools. An unknown `type` is not an error at all (§1, invariant
9).

`TOO_LATE` is a `PLAYER` error and not a special case: the press was legal, it just lost.

## 7. Idempotency

`betId` is generated by the client before the bet is sent, and it keys everything about that bet for
its lifetime.

- `placeBet` with a `betId` the server has seen **replays the original `betAccepted`** — it never
  places a second bet. This is what makes retrying after a timeout safe.
- `cashOut` with a `betId` already resolved replays the original `cashOutResult`, with the original
  multiplier. A retry cannot improve or destroy a resolution.
- `cancelBet` with a `betId` already cancelled replays the original `betCancelled`.
- A `betId` is single-use. One from a previous round, or one that was cancelled, is
  `DUPLICATE_BET_ID` when placed again — a replayed `betAccepted` for a bet that no longer exists
  would be a lie about the table.

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
  else would catch a regression there. Its message shape, and what a forced round reveals in place
  of a chain seed it did not use, are pinned with the server in **S3**; nothing in `packages/protocol`
  describes it yet.
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

The verification page's chain lookup (§3.3) is the one HTTP surface of the game.

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

**D8 — A refused bet: `betRejected`, or `error`?** `error`, with the `betId` on it. Every refusal
already needs a class and a code; a second rejection message would duplicate the taxonomy for one
verb. Cancel follows place and cash-out: a private reply with the balance (`betCancelled`), a public
broadcast without it (`betWithdrawn`).

**D9 — Curve time: float seconds or integer milliseconds?** Integer ms, with the inverse defined as
the first millisecond the forward function reaches a value. Rejected: `t = ln(m/100)/k` as a float
— the server would schedule the bust at a moment the curve does not agree it has reached.

**D10 — Is the crash point capped?** At `1,000,000.00×`. Uncapped, the formula reaches `≈4.4·10¹⁷`
hundredths, past `Number.MAX_SAFE_INTEGER`, and JSON would carry a number neither side can read
exactly. The cap binds once in a million rounds and only against a manual press nobody can make.

**D11 — Chain length, rotation, salt.** One million links, the next chain published with 50,000
left, a public salt fixed with the commit (§3.3). Rejected: ten million links (a boot-time cost for
years nobody will play), per-round commits (ADR-0001), and a beacon-derived salt for a play-money
demo — logged as the difference from a real operator rather than hidden.

**D12 — Hashes on the wire: `sha256:`-prefixed or bare?** Bare lowercase hex. `previousHash` *is* the
previous seed, so a prefix on one and not the other would make the two spellings of one value
unequal as strings.
