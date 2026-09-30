# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project status

> ⚠️ **The round is on screen; nobody can bet on it yet.** **S0–S4, C0 and C1 landed
> 2026-09-30.** S0: the workspace,
> strict TypeScript, the dependency graph and purity rules enforced and *proven to fire*, CI. S1:
> `protocol`, `money`, `curve`, `fair` — every message in [`docs/protocol.md`](docs/protocol.md) as a
> zod schema, the curve and its exact inverse, the crash point pinned against an independent
> implementation, the chain. S2: `packages/engine`, the round machine — pure, and proven over 10,000
> seeded rounds to conserve every minor unit. S3: `apps/server` — Fastify + `ws`, the round loop,
> SQLite persistence that survives a restart mid-round, the fairness endpoints, the dev surface.
> S4: `tools/sim` — a million rounds through the engine and the chain in ~13 s, every flat strategy
> returning 99% within 1σ; it found that S2 paid auto cash-outs wrong at the crash point (D14).
> C0: `packages/client-core` — the socket client, clock sync, reconnect and idempotent requests,
> proven against the real server in virtual time through 20 dropped connections across 100 rounds.
> C1: `packages/renderer` and `apps/web` — the curve, the counter and the crash on Canvas 2D in a
> Vite + React shell, measured on a throttled phone profile through a 100× round and a 5-second stall.
> ADR-0001 and ADR-0002 are accepted. **C2 — betting, cash-out, latency — is next.**
>
> The canon is four documents: `CLAUDE.md` (this file), [`ROADMAP.md`](ROADMAP.md) (the task map),
> [`docs/protocol.md`](docs/protocol.md) (the wire contract) and [`docs/adr/`](docs/adr) (the
> decisions everything else is downstream of).
>
> Below **Project description**, a section written in the present tense describes code that exists;
> one that names a block (`S1`, `C1`…) describes the shape the code **must take** when that block
> lands.
>
> **This distinction is load-bearing.** When you implement a block, rewrite its section here in the
> present tense in the same change ([Rule 0](#rule-0--keep-this-file-updated-after-every-change)) —
> and if reality diverged from the plan, the plan is what's wrong.

**This repository is standalone.** It shares no code with `../slots` and must not grow a dependency
on it — not a package, not a path alias, not a copied `tsconfig` that references it. Decisions
repeat between the two projects; modules do not.

## Project description

> ⚠️ **Keep this section current.** See [Rule 0](#rule-0--keep-this-file-updated-after-every-change).

A **real-time multiplayer crash game**. One round at a time, shared by every connected player: a
multiplier climbs from `1.00×` on a curve until it busts at a point fixed before betting opened.
Players cash out before the bust or lose their stake. Node + TypeScript server, Canvas 2D client,
one WebSocket between them.

**Target role:** game client / frontend developer at an iGaming studio. This is the second portfolio
project, and it exists to cover the axis the slot client does not: **real-time synchronisation of
one shared round across many clients**, plus **provably-fair results a stranger can verify**.

Play money only. No real money, payments or crypto — a visible 18+/demo notice instead.

### The two decisions everything hangs on

**1. The crash point is committed before the round and revealed after**
([ADR-0001](docs/adr/ADR-0001-committed-crash-point.md)). A pre-generated hash chain is consumed in
reverse; each round's seed hashes into the previously revealed one, back to a commit published in
advance. No RNG runs during a round. The verifier page uses the same `packages/fair` the server
does, so it cannot drift from the implementation it checks.

**2. Cash-out resolves on server receive time**
([ADR-0002](docs/adr/ADR-0002-server-time-cashout.md)). Nothing the client controls — reported
multiplier, timestamp, clock offset — affects a payout. The on-screen multiplier is a prediction;
server-side auto cash-out is the honest answer to latency, not a convenience feature.

Everything else in this repository is downstream of those two.

### The invariant that makes the client feel real-time

**The multiplier is a pure function of round time, and one implementation ships to both sides.**

`packages/curve` exports `m(t)` and its inverse `t(m)`. The server uses it to schedule the bust and
to price a cash-out; the client uses it to draw at 60 fps from `startedAt` alone. Ticks arrive every
~100 ms and exist to **correct drift**, not to drive animation — a client that redraws on tick runs
at 10 fps, and a client with its own copy of the curve drifts into a payout bug.

Because of this, **reconnect is trivial**: learn `startedAt`, and the entire visual state follows.
There is no catch-up, no replay, no reconciliation.

### Packages

All ten exist since **S0**, with the dependency rules applied from the first line; the four **S1**
packages are implemented, the other six are still shells whose `src/index.ts` names the block that
fills them.

| Package | Responsibility | Block |
| --- | --- | --- |
| `packages/protocol` | zod schemas + inferred types for every message in [`docs/protocol.md`](docs/protocol.md), `parseClientMessage` / `parseServerMessage` with invariant 9 built in (unknown fields stripped, unknown types dropped, a bad known type `malformed`); the error taxonomy with the class a function of the code | ✅ S1 |
| `packages/money` | branded `Minor` (the only way in is `minor()`, a safe integer or a throw), exact `add`/`sub`, `payout = floor(stake × m / 100)` refusing any inexact product, `formatMinor` for display | ✅ S1 |
| `packages/curve` | `multiplierAt` (`m`), `elapsedAt` (its exact inverse in integer ms, walked to the boundary), `smoothMultiplierAt` for drawing only, `MAX_MULTIPLIER`. Pure, tiny, load-bearing | ✅ S1 |
| `packages/fair` | SHA-256 and HMAC in plain TypeScript (NIST- and RFC 4231-vectored), `crashPoint` in `BigInt`, `createChain` with checkpoints, `verifyLink`, `verifyToCommit`. **Isomorphic** — no Node, no DOM, no dependency | ✅ S1 |
| `packages/engine` | the round machine — `step(state, event, now) → { state, effects }`, `nextDeadline`, the `hello` reads (`roundSnapshotOf`, `myBetsOf`), `tickAt`, `auditMoney`. Pure | ✅ S2 |
| `packages/client-core` | `CrashClient` — one socket through a `Transport` port, the `GameView` it keeps current (`reduce`, pure), `ClockSync`, reconnect with jittered backoff, ping liveness, `placeBet` / `cancelBet` / `cashOut` as idempotent intents, `multiplier()` and `landingMultiplier()`. **No DOM** — socket, clock and timers are injected | ✅ C0 |
| `packages/renderer` | `CrashRenderer` — draws a `Frame` (idle · waiting · running · crashed: plain numbers) on a narrow `Ctx` slice of Canvas 2D; `extents` (the axes as pure functions of time), ticks, `formatMultiplier`. **No React, no protocol** | ✅ C1 |
| `apps/server` | Fastify + `ws`: `Game` (the loop — step, persist, publish), `sockets` (frames in, effects out, `receivedAt` first), the store port with memory and SQLite twins, `ChainBook`, the HTTP probes and `/fair/*`, the boot contract | ✅ S3 |
| `apps/web` | Vite + React shell: `browserTransport`, `frameOf` (state + server time → frame, pure), `CurveCanvas` (the one rAF loop), the status pill, the announcer, `scripts/perf.mjs` | ✅ C1 · C2–C3 to come |
| `tools/sim` | `simulate` — N rounds through `engine` + `fair` (`chainRounds`), one flat-strategy player per target; the crash distribution, instant busts, strategy RTPs and the pooled edge, each beside its formula and σ; `pnpm sim` prints the tables | ✅ S4 |

**Canvas 2D, not Pixi** — deliberately. The slot project already demonstrates Pixi; a second WebGL
renderer adds nothing to read, and this game is one curve, one counter and a burst. Raw Canvas 2D is
the honest tool and shows the layer under the framework.

**What S1 measured.** A million-link chain builds in ≈0.7 s with plain-TypeScript SHA-256; with a
checkpoint every 1,000 links, any seed is ≈0.3 ms away; walking the far end of a chain back to its
commit — the verification page's worst case — is ≈0.7 s. None of it needs `node:crypto`, which is
why none of it uses it.

### Dependency rules — enforced, not suggested

Enforced by `dependency-cruiser` ([`.dependency-cruiser.cjs`](.dependency-cruiser.cjs)) in
`pnpm lint:boundaries`, which `pnpm lint` and CI run — not by discipline. Each unit has an allow-list
matching this graph exactly; anything else in the workspace is an error.

```
protocol ──▶ money
curve ──▶ (nothing)
fair ──▶ (nothing)
engine ──▶ protocol, money, curve, fair
client-core ──▶ protocol, money, curve
renderer ──▶ curve
apps/server ──▶ engine, protocol, money, curve, fair
apps/web ──▶ client-core, renderer, protocol, money, fair
tools/sim ──▶ fair, curve, engine, money, protocol
```

Hard rules on top of the graph:

- **`renderer` may not import `protocol`.** It draws numbers; it does not know what a message is.
  This is the seam that keeps the visual layer swappable and testable without a socket.
- **`engine` may not import `client-core` or `renderer`**, and contains no `ws`, no `fastify`, no
  `fs`.
- **Nothing imports `apps/*`.**
- **No package may import from `../slots`** — by relative path or by `@slot/*` name (`no-slots`),
  because a "just this one type" copy is how two standalone projects quietly become one.
- **No package imports a Node builtin** (`packages-no-node-builtins`) **or a server library** — `ws`,
  `fastify`, `pino`, the database (`packages-no-server-libs`). Node belongs to `apps/server` and
  `tools/sim`.
- **React lives only in `apps/web`** (`react-stays-in-web`).
- **A unit is reached through its entry point**, never its `src/` (`no-cross-package-deep-imports`).

**The rules are proven, not trusted.** `lint:boundaries` finding nothing in the real workspace says
nothing about whether a rule works, so [`config/fixtures/`](config/fixtures) holds deliberately
illegal imports and `tests/boundaries.test.ts` asserts each is rejected **by name** — and that the
legal allow-lists are not. A workspace import resolves to the target's `dist/`, and the config
*does not follow* `dist` rather than excluding it: excluding it would delete the edge, and an
illegal import would go quiet the moment its dependency was declared (verified against the real
workspace at S0: `renderer → protocol`, declared, is still an error).

### Purity rules for `engine`, `curve`, `fair`, `money`

Enforced by ESLint ([`eslint.config.mjs`](eslint.config.mjs), `PURE_PACKAGES`) and proven by
`tests/purity.test.ts`, which lints one impure fixture per package — a package dropped from the list
is the likeliest way for the rule to stop applying:

- No `Date.now()`, no `new Date()`, no `performance.now()`. **Time is a parameter.** The round
  machine takes `now` from its caller, which is what makes 10,000 simulated rounds run in a second
  and a bug reproduce from a fixture.
- No `Math.random()`. Randomness enters only as a seed, from `fair`, which draws it from the chain.
- No I/O, no globals, no ambient config — `fetch`, `window`, `document`, `localStorage` and `process`
  are lint errors. `fair` and `curve` must run unchanged in Node and in the browser — the
  verification page depends on it.

The compiler holds the same line from the other side: the base tsconfig has **no DOM lib and no
Node types**, so a pure package — and `protocol` and `client-core`, which must also run anywhere —
cannot name `document` or `Buffer` without failing to build. `renderer` and `apps/web` opt into the
DOM (`config/tsconfig-dom.json`); `apps/server` and `tools/sim` into Node
(`config/tsconfig-node.json`).

### The round loop lives in `apps/server`, the round logic does not

`apps/server` owns the clock, the socket set and the timers. It calls into `engine` with
`step(state, event, now) → { state, effects }` and delivers the effects. **The engine never emits;
it returns** — each effect is a `broadcast` or a `send` to one player, and every one is a message
the wire schema accepts (the engine suite parses them all). That is what lets `tools/sim` run
millions of rounds through the same code that serves the demo, and what makes "the RTP you publish
is the RTP you play" checkable rather than claimed.

How the engine (**S2**) is shaped, because the server and the sim both lean on it:

- **Every step first settles what was due.** Betting closes at `bettingClosesAt`, auto cash-outs fire
  at `startedAt + t(autoCashOutAt)`, the round busts at `startedAt + t(crashPoint)` — at those
  *scheduled* moments, before the event at `now` is judged. A late server timer therefore changes
  nothing: not `startedAt`, not the crash moment, not what an auto cash-out pays (exactly its
  target, even when the curve jumped past it in that millisecond). And an event received at `now`
  is ordered after everything due before it, which is ADR-0002's "receive order is the order" in
  code: at the same millisecond the crash beats a press and an auto cash-out beats a manual one.
- **An auto cash-out wins iff `autoCashOutAt ≤ crashPoint`** — decided on the values when the round
  starts, not on the moments (docs/protocol.md §4, D14). S2 compared moments, `t(target) <
  t(crashPoint)`, which lost every target equal to the crash point and every target the curve
  passed in the crash millisecond: a 1.01× strategy returned 98.1% instead of 99% (z = −14 over
  50,000 rounds, measured by accident on a stale build). S4 found it by asking what the simulation
  would have to show before running it; the engine test pins both cases.
- **The caller does two things:** hands in events with a non-decreasing `now` (backwards is an
  `EngineError`), and opens rounds, because it holds the chain and the engine only verifies the link
  (`openRound` refuses a seed that does not hash to its claimed `previousHash`). `nextDeadline` says
  when the next timer is due and whether it is an `advance` or an `openRound`.
- **Players cannot break it; callers can.** Everything a player sends is answered with an `error`
  effect. An `EngineError` is thrown only for a caller bug — opening a round mid-round, time running
  backwards — and means stop and fix the caller.
- **Balances live in the engine**, with `granted` (money in) and `house` (net take), so
  `auditMoney` can state the conservation law: every minor unit granted is in a balance, a stake
  still riding, or the house.
- **The idempotency window is the current round and the previous one.** A retry straddling the
  boundary gets its original answer; a `betId` from further back is the server's to refuse, from the
  store (below).

How the server (**S3**) is shaped around it:

- **Every change is step → persist → publish** (`Game.commit`). The engine steps first — it is pure,
  so that commits to nothing — then the event and everything it implies (a consumed chain link, a
  claimed `betId`, at a crash the checkpoint and the reveal) are written in **one transaction**, and
  only then is the new state adopted and its effects delivered. Nothing reaches a socket that is not
  on disk; a crash between the write and the send replays to the same state, and the client's retry
  gets its original answer.
- **Persistence is a journal and a checkpoint** behind the `Store` port — `memoryStore` for tests
  and a throwaway dev server, `sqliteStore` (better-sqlite3: synchronous, so no `await` lets another
  event slip between step and write; WAL with `synchronous = FULL`) for everything else, both held
  to one contract suite. After each crash the engine state is checkpointed and the journal emptied;
  every player event since is journaled with its `now` (`advance` is not — replay recomputes it).
  **A restart replays the journal onto the checkpoint through the pure engine**, then advances to
  the present, so an auto cash-out or a bust that fell due while the process was down settles at
  its scheduled moment. `tests`: a restart mid-round resumes the same round, bet and balance; a
  restart after the crash moment finds the 1.50× auto cash-out paid and the reveal published.
- **The chain** (`ChainBook`) is generated once — from `CRASH_DEV_CHAIN_SEED` in development, from
  the CSPRNG otherwise — and only ever added to: a chain whose `s₀` no longer produces its published
  commit refuses to load. The next chain is published with `rotateAt` rounds left; its ≈0.7 s of
  hashing runs in the pause after a crash, when nothing is in flight to be stamped late.
- **`receivedAt` is the first line of the frame handler**, before decoding or parsing. A simulated
  slow uplink (`devFaults`) delays the *arrival*, so it is stamped after the delay — network, not
  load.
- **`betId`s are single-use for good**: the store keeps every accepted one, and a reuse the engine's
  one-round memory would miss is refused before the event reaches it.
- **The boot contract** (`config.ts`): a production server refuses `:memory:`, a missing database
  and a dev chain seed, naming every violation at once. `devForceCrashPoint` is heard only in
  development; `devFaults`/`devDisconnect` only with `CRASH_FAULTS=on` (default in development,
  opt-in in production for the live demo, since they touch only the sender's own socket). A server
  that does not listen drops them as unknown types — tested with hand-crafted frames.
- **Logs are one pino line per thing that happened, keyed by `roundId`**, and never carry a seed
  before its reveal — the only line with one is the crash, where it is public. Tested over a real
  round: no line before the crash contains its seed, and no line ever contains `s₀`.

### The client core keeps the round; it never decides it

`packages/client-core` (**C0**) is everything a client needs short of pixels, behind ports — a
`Transport` (the browser's `WebSocket` in `apps/web`, an in-process pipe in tests), a `Clock` and a
`Scheduler` — so the very same code runs in the browser and against the real server in virtual time.

- **The view is rebuilt from `hello` and kept current by a pure reducer** (`view.ts`). Every
  number in it came from the server. A message that does not fit — an unknown `roundId`, a phase
  skipped — sets `resync`, and the client asks for a fresh `hello` on the same socket rather than
  guessing (§1, invariant 8).
- **Replays change nothing.** A retried request is answered with the original reply, whose balance
  is as old as the original, so a reply is applied only the first time it changes a bet. A bet
  withdrawn this round is remembered, because a `betAccepted` still in flight from before the cancel
  would otherwise resurrect it with a stale balance — found by the reducer tests, fixed in the view.
- **A request is an intent with one `betId`**, generated at the call. A timeout, a `SYSTEM` error or
  a reconnect sends the same message again; only a reply or a `PLAYER` error ends it. The server's
  idempotency (§7) does the rest.
- **Reconnect is a new `hello`**: exponential backoff with ±20% jitter, then `authenticate` with the
  stored token (an unknown one starts a new wallet). The last view is kept through the drop — stale,
  not blank. **Liveness is the ping**: three missed pongs and the socket is treated as dead whether
  or not it said so.
- **The multiplier is never stored**: `multiplier()` is `m(now + offset − startedAt)`, and
  `landingMultiplier()` adds half the rtt — what a press will most likely land on (ADR-0002).

To run the real server in virtual time, S3's socket layer was split in C0: `hub.ts` is the
connection logic over a `Peer` (anything with `send` and `terminate`), `sockets.ts` the `ws`
adapter, and `createGameServer` the loop, chains and hub without Fastify.

### The web client draws from the clock, never from the wire

`apps/web` (**C1**) is a Vite + React shell around one canvas. React renders the shell — the status
pill, the balance, the notice, a polite live region that announces each phase — and **nothing that
changes per frame**. The canvas has its own `requestAnimationFrame` loop: read the client's state,
turn it into a `Frame` with `frameOf(state, client.serverNow())`, hand it to the renderer. So ticks
never drive a frame; they only correct drift inside `client-core`.

- **The axes are pure functions of the round** (`renderer/viewport.ts`): a smooth maximum of a
  resting extent (8 s × 2.00×) and a growing one, so no two frames differ by more than the round
  moved (tested: under 2% per frame through a 90-second round). The exponential rescaled this way
  is self-similar — the curve keeps its shape all the way up and the climb reads in the labels. This
  closed the "past ~20×" gap.
- **The counter is `multiplierAt` formatted in integer hundredths** — the wire's quantisation — and
  sits *behind* the line. The crash freezes it red at `crashPoint`, the line stops at `crashedAt −
  startedAt`, the sparks are a pure function of time since the crash, and the note says whether the
  round is verifiable (`round #n · seed revealed`) or forced (dev).
- **The backing store is sized at the device pixel ratio capped at 2**, re-read by a
  `ResizeObserver`. No `shadowBlur` anywhere: the glow is a wide translucent stroke under the line.
- **`__ASSERT_CURVE__` and the dev hooks** (`window.__crash`: the client, the last drawn frame, a
  raw send down the player's own socket) exist in every build but production. `--mode perf` is a
  minified build that keeps them, for the perf probe.
- **`apps/web` resolves modules the bundler's way** (`moduleResolution: Bundler`, extensionless
  imports) — the one exception to S1's `NodeNext`, because Vite bundles it and Node never loads it.
  The library packages declare `sideEffects: false`.

**What C1 found:** the browser's clock (`performance.timeOrigin + performance.now()`) is fractional,
and `client-core` sent it as `ping.clientTime` — which the protocol makes an integer. Every ping was
`MALFORMED_MESSAGE`, clock sync never ran in a browser, and liveness dropped the socket every 15 s.
The virtual-time tests used integer clocks and the scripted fake server accepted any JSON, so
nothing saw it until the perf run's stall check measured a 2-second "stall" (a reconnect had
interrupted it). The client now floors the clock onto the wire; the fake server parses every client
frame with the real parser and fails on a malformed one; and the perf gate fails on any error or
reconnect.

### Testing layers

| Layer | What it proves | Block |
| --- | --- | --- |
| Unit | `curve`: the inverse lands on the boundary for every step to 100× and for random targets to the ceiling on four curves, `t(m(t)) ≤ t` showing the same value · `fair`: NIST and RFC 4231 vectors, chain links, forged seeds refused · `money`: exact arithmetic, overflow refused · `protocol`: a fixture of every message, invariant 9, class-of-code | ✅ S1 |
| Golden | 30 seeds → crash points, plus other edges and a ten-link chain — **computed by an independent Python implementation**, so the golden values pin correctness, not just stability. Also run in happy-dom (`isomorphic.test.ts`) | ✅ S1 |
| Contract sync | `tests/protocol-doc.test.ts`: the §2 message table and §6 error table name exactly what the schemas accept · `tests/constants.test.ts`: the multiplier range agrees across `curve`, `fair`, `protocol` | ✅ S1 |
| Engine | every phase transition and every player refusal · a press 1 ms either side of the crash · racing presses on one `betId` · auto against manual in the same and the previous millisecond · auto cash-outs paying their target when processed late · retries across the round boundary · nothing secret in any effect, snapshot or tick before the crash · and **10,000 seeded rounds** (≈63k bets, ≈22k manual wins, ≈11k late presses, ≈6k retries) with money audited after every step and every bet resolved exactly once | ✅ S2 |
| Statistical | `tools/sim`: in CI, 50,000 seeded rounds with every rate within 4σ of its formula, zero auto cash-outs off the D14 rule, money conserved, and a check that S2's tie rule would sit >9σ out; by hand, `pnpm sim` over a million (below) | ✅ S4 |
| Client ↔ server | `tests/client-server.test.ts`: `packages/client-core` against `createGameServer` in one virtual clock over an in-process network — **20 connections cut across 100 rounds**, the cuts taking turns at BETTING, RUNNING and CRASHED, the client held to the server's phase, table, bets, balance and multiplier after every reconnect and at every step; and 40 ms up / 120 ms down, the offset at exactly −40 and the drawn multiplier exactly `m(now + offset − startedAt)`. Checked non-vacuous by breaking the reducer and watching it fail. Plus the client's own suite on a scripted server: asymmetric latency, an hour of clock skew, timeouts, `SYSTEM` retries, backoff, half-open liveness, session reset, drift | ✅ C0 |
| Renderer + web | `renderer`: axes continuous frame to frame and always holding the head, ticks on step multiples with the step's own precision, the counter's formatting, drawing through a recording context that throws on any non-finite number · `apps/web`: `frameOf` for every phase, a stale view, the verifiable and forced notes | ✅ C1 |
| Perf (C1 gate) | `pnpm perf:web` — two real Chromium pages, a forced 100× round, a 5 s stall on the phone's own socket (below) | ✅ C1 · real devices in P0 |
| Integration | `apps/server` on a random port with real `ws` clients: two players in one round with the reveal verified against the published commit · restart mid-round and after the crash moment (SQLite) · production dropping dev frames · a forced round claiming no link · faults on one connection only · the wire's refusals · `betId` single-use across rounds · the log leak check. Plus the store contract (memory and SQLite, including across a reopen), the codec, the chain book and the boot contract | ✅ S3 · load and chaos in P0 |
| E2E | Playwright, **two browser contexts in the same round**, one cashing out, one busting | P1 |

What `pnpm perf:web` measured (2026-09-30):

**C1 perf** · forced 100× round · phone: 375×812 @ DPR 3 (drawn at 2), CPU 4× throttled · headless Chromium

| Measure | Result |
| --- | --- |
| Phone frames through the round | 3685 over 30.7 s |
| Frame time p50 / p95 / max | 8.3 ms / 9.4 ms / 15.7 ms |
| Frames over 25 ms | 0 of 3684 (0.00%) |
| Heap before → after the round | 10.0 → 10.0 MB |
| 5 s stall: longest silence on the phone's socket (proof it happened) | 5033.7 ms |
| 5 s stall: longest gap between frames | 15.7 ms |
| 5 s stall: frames where the counter went backwards | 0 |
| 5 s stall: worst leap beyond the curve's own rise | 0 hundredths |
| Phone's clock estimate, drift across the round | 0.4 ms |
| Phone: errors heard / reconnects, whole run | 0 / 0 |
| Side by side: frame pairs within 2 ms | 3681 |
| Side by side: clock disagreement (max) | 0.8 ms |
| Side by side: counter disagreement at one instant (max) | 1 hundredths |

The statistical layer is the one that would be missing from a weaker version of this project, and
it is the one that proves the house edge is where ADR-0001 says it is. What it measured
(`pnpm sim -- --rounds 1000000`, 2026-09-30, the demo's config):

**1,000,000 rounds** through `engine` + `fair` · house edge 100 bps · chain commit `3eb73ea74f9a99df…` · 13.4 s

| Flat strategy (auto cash-out) | Bets | Win rate | RTP | Expected | σ | z |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| always 1.01× | 1,000,000 | 98.01% | 98.987% | 99.0% | 0.014% | -0.95 |
| always 1.50× | 1,000,000 | 65.97% | 98.949% | 99.0% | 0.071% | -0.72 |
| always 2.00× | 1,000,000 | 49.48% | 98.955% | 99.0% | 0.100% | -0.45 |
| always 10.00× | 1,000,000 | 9.90% | 98.961% | 99.0% | 0.299% | -0.13 |
| always 100.00× | 1,000,000 | 1.00% | 99.880% | 99.0% | 0.990% | 0.89 |

Realised house edge, all bets pooled: **0.854%** against 1.0% (σ 0.208%, z -0.70) — 4,269,034 of 500,000,000 staked.

| P(crash ≥ m) | Observed | Expected `(1 − E)/m` | z |
| --- | ---: | ---: | ---: |
| 1.01× | 98.007% | 98.020% | -0.95 |
| 1.50× | 65.966% | 66.000% | -0.72 |
| 2.00× | 49.477% | 49.500% | -0.45 |
| 5.00× | 19.772% | 19.800% | -0.70 |
| 10.00× | 9.896% | 9.900% | -0.13 |
| 100.00× | 0.999% | 0.990% | 0.89 |
| 1000.00× | 0.106% | 0.099% | 2.29 |
| instant bust (1.00×) | 1.993% | 1.980% | 0.95 |

Median crash 1.97× · p99 99.90× · max 1000000.00× · longest run below 2× 19 rounds.
Auto cash-outs off the D14 rule: 0 · money conserved: yes.

## Commands

Everything runs from the repo root on Node ≥ 20.19 (CI uses 22) and pnpm 10. The one command before
every commit:

```bash
pnpm check
```

| Command | What it does |
| --- | --- |
| `pnpm check` | lint → build → typecheck → unit tests → root suites → format check. **What CI runs.** |
| `pnpm lint` | ESLint (purity, type-safety) and `lint:boundaries` |
| `pnpm lint:boundaries` | dependency-cruiser over `packages/`, `apps/`, `tools/` |
| `pnpm build` | `tsc` to `dist/` per unit, in dependency order (Turborepo) |
| `pnpm typecheck` | the root suites' tsconfig, then every unit's |
| `pnpm test` | each unit's own `src/**/*.test.ts` (`config/vitest.package.ts`) |
| `pnpm test:root` | `tests/` — the rules proven against `config/fixtures/` |
| `pnpm format` | Prettier. Markdown is excluded: the canon is hand-wrapped |

Units resolve each other through their built `dist/` and package `exports`, ordered by Turborepo's
`^build` — not through TypeScript project references, which ROADMAP S0 planned and which would
duplicate what Turborepo already orders. `build` therefore runs before `typecheck` and the tests.

`pnpm dev:server` runs `apps/server` in watch mode (development: in-memory store, faults on, a
fresh chain each start unless `CRASH_DEV_CHAIN_SEED` is set). Its knobs are environment variables
read in `apps/server/src/config.ts` — `CRASH_DB`, `CRASH_GROWTH_RATE`, `CRASH_BETTING_MS`,
`CRASH_CHAIN_LENGTH` and friends. `pnpm sim -- --rounds 1000000 [--seed <hex>] [--json]` builds the
sim **and everything it depends on** (Turborepo) before running it — S4 first ran it against a
stale engine `dist/` and measured the bug it had already fixed. `pnpm dev` runs the server and the
web app together (Vite on :5173, proxying `/ws` and `/fair` to :8080; `CRASH_SERVER` moves the
target). `pnpm perf:web` builds everything, then measures the C1 gate in real Chromium (below).

**Module resolution is `NodeNext`**, so a relative import carries its `.js` extension and the
compiler refuses one that does not. Found in S1: under `Bundler` resolution `tsc` emitted
extensionless imports that Vite and Vitest resolve and plain Node does not — `apps/server` and
`tools/sim` would have failed on their first `import '@crash/fair'`. Test data a package ships to
its own tests lives in `src/__fixtures__/`, which the build excludes.

A pre-commit hook (husky → lint-staged) runs ESLint and Prettier over staged files. `turbo.json`
sets `agentGuidance: false`: Turborepo ≥ 2.11 otherwise writes an `AGENTS.md` whenever it detects an
AI agent, and this file is where the repository's guidance lives.

## Gaps & missing pieces

Log what you hit here as you hit it ([Rule 1](#rule-1--log-the-gaps-you-hit)). Open at time of
writing:

- **Betting-phase length under real latency.** 7 s is a placeholder. **P0** measures whether a
  300 ms client can reliably place a bet in it.
- **Half-open sockets.** The server never pings; a client that vanished without a close frame
  stays in the broadcast set until TCP gives up. Harmless at demo scale, and exactly what **P0**'s
  "half-open connections" item is for — a server-side heartbeat, measured under load.
- **Sessions never expire.** A token names a play-money wallet forever, and `SESSION_INVALID` only
  ever means "unknown". Fine for the demo; a real session lifetime would be a **P1** decision with
  the host.
- **The salt is fixed, not beacon-derived.** docs/protocol.md §3.3 records it: a real-money operator
  would take each chain's salt from public randomness published after the commit, so `s₀` could not
  be ground for a favourable chain. Accepted for a play-money demo; revisit only if the project
  ever claims more than that.
- **The host versus a chain that must survive a redeploy.** P1 plans Fly or Railway with SQLite on a
  volume; the slot project (2026-09-26) found that the no-card free tier it could actually use —
  Render — has no persistent disk and sleeps after 15 idle minutes. Worth noting before P1 picks:
  the chain is fully determined by `s₀` and its length, so "never regenerate" means *never draw a new
  `s₀`* — `s₀` can live as a secret, and only the consumed index needs durable storage. **P1**
  decides the host and where that index lives. S3 made the stakes concrete: the SQLite file holds
  the balances and the journal too, so a host without a disk loses more than the cursor.
- **The perf numbers are headless Chromium, not a phone.** `pnpm perf:web` throttles the CPU 4× and
  emulates a 375×812 DPR-3 screen, and headless frames run at 120 Hz — the same caveat as the slot
  project's harness. A real mid-range Android is **P0**'s to measure, with the betting window.
- **The client bundle is 101 KB gzipped**, most of it React and zod. The dev message *schemas* ride
  along (a top-level zod call is not provably pure, so the bundler keeps it) — inert, since the
  client never sends one and the server decides whether to listen; the dev *hooks* and
  `__ASSERT_CURVE__` are stripped (checked by grepping the production bundle). **P1** can split
  `@crash/protocol/dev` if the bytes ever matter.
- **The line ends where the client last drew it, then snaps to the crash.** The crash arrives a
  one-way latency after it happened, so the curve has been drawn that far past the crash point and
  the break pulls it back — ~60 ms of curve at typical latency, invisible below ~50×. A crash during
  a network stall shows the same effect for the length of the stall; nothing but the crash message
  can end a round on screen. Accepted, and stated here so nobody "fixes" it by guessing ahead.

## Rules

### Rule 0 — Keep this file updated after every change

When a block lands, rewrite its sections here in the **present tense** in the **same change**, and
tick it off in [`ROADMAP.md`](ROADMAP.md). A section describing an intent the code no longer has is
worse than no section: the next reader trusts it.

If the code diverged from the plan, the plan is what's wrong. Fix the document, and if the
divergence touched a pinned decision, write or amend an ADR.

### Rule 1 — Log the gaps you hit

When you hit something the canon doesn't answer, add it to **Gaps & missing pieces** with the block
that should close it — then keep working. Delete the entry in the change that fills it. The list is
a work queue, not an archive.

### Other rules

- **The protocol document and `packages/protocol` change together**, in one commit, always.
- **No `any`, no non-null `!`, no `as` outside a parser boundary.** `strict`,
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; the three bans are lint errors in
  every unit's source (tests excepted), proven by `tests/type-safety.test.ts`. `as const` stays
  legal. A boundary that genuinely needs an assertion carries an `eslint-disable-next-line` saying
  why — zod's `parse` returns the type, so most need none.
- **Every message is parsed with its zod schema at the boundary**, on both sides. The server does
  not trust the client; the client does not trust the server either, because a schema mismatch is a
  deploy-skew bug worth failing loudly on.
- **Never log or return a round seed before its reveal** — including in errors, traces and debug
  panels. This is the one leak with no recovery.
- **Money never touches a float.** Payout is `floor(stake × multiplier / 100)` in minor units, with
  `multiplier` in hundredths of 1× as it travels on the wire (`421` is `4.21×`).
