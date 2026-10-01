# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project status

> ⚠️ **Every block has landed: the game is playable, every round verifiable, hardened against a real
> crowd's network, and live** at <https://crash-demo-ut88.onrender.com/>. **S0–S4 and C0–C2 landed
> 2026-09-30, C3, P0 and P1 2026-10-01.** S0: the workspace,
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
> C2: the bet panel, the cash-out that prices a press half a round trip ahead, auto cash-out and the
> result moment — played 30 rounds on a 300 ms link with every manual cash-out paid what the button said.
> C3: the live player list, the history strip, and the verification page — a stranger's lost round
> recomputed in the browser and walked back to the commit their own `hello` carried, with three kinds
> of lying server caught on the way. P0: a crowd of real clients — slow, lossy, frozen, dark,
> an hour off, stormed — against the server for 30 minutes, in virtual time in CI and over real
> sockets by hand, ending with no money made or lost and nobody in a wrong state; it found and fixed
> a clock estimate 400 ms off under loss (D18), a client that could wait for a `hello` forever, and
> half-open sockets left in the broadcast. P1: one Docker image serving the game from one origin,
> deployed to Render's free tier after CI passes — no disk, so a fresh chain under a new id at every
> boot (ADR-0003) — and a Playwright suite in CI: two browsers in one forced round agreeing frame for
> frame, and a stranger who bets, is dropped by the server, recovers and verifies the round, the same
> spec run against the live demo.
> ADR-0001, ADR-0002 and ADR-0003 are accepted.
>
> The canon is four documents: `CLAUDE.md` (this file), [`ROADMAP.md`](ROADMAP.md) (the task map),
> [`docs/protocol.md`](docs/protocol.md) (the wire contract) and [`docs/adr/`](docs/adr) (the
> decisions everything else is downstream of). [`docs/architecture.md`](docs/architecture.md) is the
> map for a first-time reader; it summarises, and where it and this file differ, this file is right.
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

All ten exist since **S0**, with the dependency rules applied from the first line, and all ten are
implemented — the last, `apps/web`, completed by **C3**.

| Package | Responsibility | Block |
| --- | --- | --- |
| `packages/protocol` | zod schemas + inferred types for every message in [`docs/protocol.md`](docs/protocol.md), `parseClientMessage` / `parseServerMessage` with invariant 9 built in (unknown fields stripped, unknown types dropped, a bad known type `malformed`); the error taxonomy with the class a function of the code | ✅ S1 |
| `packages/money` | branded `Minor` (the only way in is `minor()`, a safe integer or a throw), exact `add`/`sub`, `payout = floor(stake × m / 100)` refusing any inexact product, `formatMinor` for display | ✅ S1 |
| `packages/curve` | `multiplierAt` (`m`), `elapsedAt` (its exact inverse in integer ms, walked to the boundary), `smoothMultiplierAt` for drawing only, `MAX_MULTIPLIER`. Pure, tiny, load-bearing | ✅ S1 |
| `packages/fair` | SHA-256 and HMAC in plain TypeScript (NIST- and RFC 4231-vectored), `crashPoint` in `BigInt` and `crashPointTrace` (the same, with its HMAC and 52 bits shown), `createChain` with checkpoints, `verifyLink`, `verifyToCommit`, `hashTimes` (the walk to the commit, in slices). **Isomorphic** — no Node, no DOM, no dependency | ✅ S1 · C3 |
| `packages/engine` | the round machine — `step(state, event, now) → { state, effects }`, `nextDeadline`, the `hello` reads (`roundSnapshotOf`, `myBetsOf`), `tickAt`, `auditMoney`. Pure | ✅ S2 |
| `packages/client-core` | `CrashClient` — one socket through a `Transport` port, the `GameView` it keeps current (`reduce`, pure), `ClockSync` (offset of the fastest of five samples, median rtt — D18), reconnect with jittered backoff, ping liveness and a deadline on `hello`, `placeBet` / `cancelBet` / `cashOut` as idempotent intents, `multiplier()` and `landingMultiplier()`, `sendDev`. **No DOM** — socket, clock and timers are injected | ✅ C0 · P0 |
| `packages/renderer` | `CrashRenderer` — draws a `Frame` (idle · waiting · running · crashed: plain numbers) on a narrow `Ctx` slice of Canvas 2D; `extents` (the axes as pure functions of time), ticks, `formatMultiplier`. **No React, no protocol** | ✅ C1 |
| `apps/server` | Fastify + `ws`: `Game` (the loop — step, persist, publish), `hub` (frames in, effects out, `receivedAt` first; a broadcast serialised once) with a `Lane` per direction per connection for the dev faults, `sockets` (the `ws` adapter and its heartbeat), the store port with memory and SQLite twins, `ChainBook` (the first chain named `1` or by its boot second), the HTTP probes, `/fair/*` and the development-only `/dev/audit`, the built web app from `/` (`CRASH_STATIC_DIR`), the boot contract | ✅ S3 · P0 · P1 |
| `apps/web` | Vite + React shell: `browserTransport`, `frameOf` (state + server time → frame, pure), `CurveCanvas` (the one rAF loop), the status pill, the announcer; `panelModel` (pure), `BetPanel`, `CashOutButton`, `ResultBanner`, `useBetting`; `tableModel` and `gradeOf` (pure), `PlayerTable`, `HistoryStrip`, `HowItWorks`; the hash router (`route.ts`, including `#/verify/latest`) and the verifier — `verifyRound` and `knownFrom` (DOM-free), `VerifyPage`; `scripts/perf.mjs`, `scripts/play.mjs`, `scripts/verify.mjs` | ✅ C1–C3 · P1 |
| `tools/sim` | `simulate` — N rounds through `engine` + `fair` (`chainRounds`), one flat-strategy player per target; the crash distribution, instant busts, strategy RTPs and the pooled edge, each beside its formula and σ; `pnpm sim` prints the tables | ✅ S4 |
| `tools/load` | `Population` — a crowd of real `CrashClient`s on links of their own, with habits (bet, cancel, auto or a press at a target) and the fault schedule (stall, blackhole, storm), held to a `Truth` with `compare`; `pnpm load` runs it over `ws` against a server process and reads the truth from `/dev/audit` | ✅ P0 |

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
tools/load ──▶ client-core, protocol, money, curve
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
  slow or lossy uplink (`devFaults`, `devStall`) delays the *arrival*, so it is stamped after the
  delay — network, not load.
- **`betId`s are single-use for good**: the store keeps every accepted one, and a reuse the engine's
  one-round memory would miss is refused before the event reaches it.
- **The boot contract** (`config.ts`): a production server refuses `:memory:`, a missing database
  and a dev chain seed, naming every violation at once. `devForceCrashPoint` is heard only in
  development; `devFaults`/`devStall`/`devDisconnect` only with `CRASH_FAULTS=on` (default in development,
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

### The cash-out says what it will get before you press it

**C2** puts money on the curve. Every control follows one rule: it is derived, never stored —
`panelModel(state, form, pending)` is a pure function from the client's state and what the player
typed to what the panel shows and allows, **and a disabled control always carries the reason**
(the minimum, the maximum, the balance, the auto cash-out range, a request in flight, a reconnect).

- **One primary action whose meaning follows the round**: place during `BETTING`, cancel once the
  bet is on the table, cash out while it rides — Space presses it unless you are typing.
- **The cash-out is priced half a round trip ahead.** The curve shows where the round is on the
  server now; a press reaches the server `rtt/2` later, so the button shows
  `payout(stake, landingMultiplier())` and "lands ≈ x.xx× · ping n ms" (ADR-0002). Its label changes
  every frame, so it is written straight to the DOM from its own animation frame, never through
  React state — the C1 principle applied to a button.
- **At the press, the panel records what the curve showed and what the button promised**, and the
  result banner shows both beside what the server paid. The gap between the curve and the payout is
  explained where the player looks for it.
- **Auto cash-out is offered with the reason it is better**: it fires on the server at exactly the
  target, with no network in the way.
- **The balance is only ever the wire's.** Typed stakes are parsed digit by digit into minor units
  (`0.29` is 29, never 28.99…), and anything with a third decimal is refused, not rounded.
- **The result moment** — `+5.80 · cashed out at 1.16×` or `BUSTED · crashed at 1.38×` — appears
  when the money moves (an auto cash-out and another tab's press included, because it follows the
  wire, not the button) and is cleared by the next `bettingOpen`.

**What C2 found:** the dev hook that feeds `scripts/play.mjs` was never wired — a replacement that
Prettier had already reformatted silently did not apply, and the first measurement reported zero
cash-outs. The gate caught it because it fails when it has too few samples to judge, rather than
passing on none.

### The verifier takes nothing on trust

**C3** puts the table and its proof on screen. The game screen gains the history strip above the
curve and a side column — the bet panel, the live player list, a "how this works" panel linking the
ADRs. The verifier is a second screen in the same app, `#/verify/:chainId/:chainIndex`: a hash route,
so a link to a round works pasted anywhere and served by any static host; the client and its socket
outlive the switch, so leaving the table to check a round is a re-render, not a reconnect.

- **The player list shows what the wire makes public, and nothing it does not** (`tableModel`,
  pure): nick, stake, and the multiplier each player got with what it paid — derivable from two
  public numbers, so not a balance. A bet riding on auto looks like any other (D4); a test holds the
  rows to their fields. Your own bet sits on top, the rest by stake, and a cash-out fills its row in
  place rather than reordering the list under the reader's eye.
- **Every past crash point is a link.** `hello.history` carries each round's place in the chain
  (D16), and the client builds the newest entry from `crash.fair` itself. A forced round has no
  link and is drawn dashed. The bust banner links straight to the round just lost.
- **The server is asked for the claim, and the browser checks it** (`verifyRound`, DOM-free). It
  fetches `GET /fair/chains` and the round's reveal, parses both with the protocol schemas, then
  recomputes everything with `@crash/fair` — the code the server drew the result with: the seed
  hashes to the previous one; `crashPointTrace` gives the HMAC, the 52 bits and the crash point,
  which must equal the recorded one; and `hashTimes` walks the seed back to the commit,
  `chainIndex` hashes in slices of 10,000 with a macrotask break between them, so the far end of a
  million-link chain never costs a frame. 20,000 a slice was the first guess; it measured ≈25 ms in
  headless Chromium and dropped a frame every slice.
- **What the browser knew before is the part that makes the result predate the bet** (`knownFrom`):
  the commit, salt and house edge it was handed in `hello` when it joined, and the crash point it
  was shown for the round — at the crash, or in `hello.history`. Both are read afresh on every render, not captured when the check
  starts — a page opened cold from a link is still joining while it walks, and the first version,
  which captured them, left step 5 unchecked on exactly that page (found by the gate).
- **A server that lies gets a red step, not a footnote.** A crash point the seed does not produce,
  a forged seed, a previous seed passed off as this round's, a commit, salt or edge changed after
  the browser joined, a reply that does not parse — each fails its step and the verdict says *does
  not verify*. An unrevealed round is refused by the server (404) and the page says why.

**What C3 found:** the canvas carried `touch-action: none`, harmless while the game fitted one phone
screen; with the player list below the fold, a swipe that began on the curve could not scroll the
page. It is `pan-y` now. And `verifyRound` first captured the browser's own knowledge at the start
of a check — the gate, opening a verification link cold, saw step 5 left blank.

### Hardening: what a real crowd does to it

**P0** turned the server and the client loose on a crowd and broke the crowd's networks on purpose,
the way real ones break — then held every player to the server's account of it.

- **Loss is late, never lost** (D17). Each direction of each connection runs through a `Lane`
  (`apps/server/src/link.ts`): a fixed latency, and with probability `lossRate` a frame's packet is
  resent after TCP's retransmission timeout (200 ms, doubling) while every frame behind it waits.
  `devStall` freezes both lanes, `devDisconnect` closes the socket from the server's end (a close
  frame, code 4000 — P1). S3's `dropRate` discarded frames
  mid-connection — a fault no WebSocket produces — and is gone. **Order is the lane's queue, not
  its timers**: the first version armed a timer per frame, and the load run caught real Node timers
  firing late enough for a tick to overtake its round's crash — 114 resyncs in two minutes, and one
  player whose cash-out landed after the next round had opened, its balance silently lost until the
  next `hello`. Virtual time never fires late, so only real time could find it.
- **The clock offset is the fastest sample's, the rtt the median** (D18). Under 20% loss a
  median-of-five offset put a client up to 400 ms behind the server — its countdown long, its curve
  late. The lowest-rtt exchange waited least and is wrong by at most half its own trip.
- **A socket that dies silently is noticed from both ends.** The server pings every socket at the
  protocol level every 10 s (`CRASH_HEARTBEAT_MS`) and terminates one that missed the previous ping —
  the half-open gap is closed. The client already dropped a socket after three missed pongs, but
  pings start at `hello`: a link that went dark between the open and the `hello` left it "joining"
  forever. It has a deadline of the same three intervals now.
- **A broadcast is serialised once**, not once per socket.
- **The betting window is measured, and kept at 7 s.** A 300 ms client's `bettingOpen` lands with
  6.84 s left; a lossy one's with 6.95 s (p50). What was missing was the panel saying so: a bet or
  a cancel sent later than `bettingClosesAt − rtt/2 − 150 ms` (`lastCallAt`) would arrive after the
  close, so from that moment the button is disabled with the reason and the ping — the betting
  window's counterpart of the cash-out's landing price.
- **A lying clock moves nothing.** `ping.clientTime` is the only time a client sends; a client that
  sends the epoch and the end of time and then presses is paid exactly what an honest one pressing
  at the same server moment is (`tests/hostile-clock.test.ts`). An hour-off clock plays correctly —
  a tenth of every crowd below runs one.
- **The network lab** (`apps/web`, `NetworkLab`) puts the faults on the live demo, on the
  reviewer's own socket only: latency, loss, a 3-second freeze, a dropped connection — re-applied
  after every reconnect, with a log of what the client did about it.

The crowd is `tools/load`'s `Population`, and it runs twice:

- **In CI, in virtual time** (`tests/soak.test.ts`): 200 players for 10 minutes against
  `createGameServer` — a fifth on a 300 ms link, a fifth on a lossy one, a tenth an hour off; every
  20 s 3% of links frozen for 3 s, every 45 s 1% gone dark, every 2½ minutes 40% of the crowd dropped
  mid-round. The money law is audited every virtual second; at the end every player must be live
  and agree with the engine on the round, the history, its wallet and its bets. ≈6 s. `SOAK_PLAYERS`
  and `SOAK_MINUTES` run it larger (500 × 30 minutes passes in 3½ minutes). Checked non-vacuous by
  breaking the reducer's cash-out balance and watching it name the players it left wrong. The
  virtual clock is a binary heap now — a linear scan per timer made a crowd quadratic.
- **By hand, in real time** (`pnpm load -- --clients 500 --minutes 30`): the same crowd over real
  sockets against a server process on SQLite, with a reconnect storm every five minutes, held at
  the end to `GET /dev/audit` (below).

### One image, one origin, and a demo that forgets on purpose

**P1** ships it. The decisions are [ADR-0003](docs/adr/ADR-0003-demo-host.md)'s; this is the shape.

- **One image** (`Dockerfile`): Debian slim, so `better-sqlite3` installs a prebuilt binary rather
  than compiling SQLite; a `pnpm deploy` production tree of `apps/server` with the production web
  build beside it; `CRASH_ENV=production`, the database at `/app/data/crash.db` (a host with a disk
  mounts `/app/data`), a healthcheck on `/ready`. 404 MB, ≈44 MB resident.
- **One origin.** With `CRASH_STATIC_DIR` the server serves the web app from `/` beside `/ws` and
  `/fair/*` — the page already speaks to its own origin, so it needs no CORS, no server address and
  no proxy. Hashed assets are `immutable` for a year; `index.html` is `no-cache`, so a returning
  browser never runs last deploy's client against this deploy's server. The API routes are more
  specific than the static wildcard, so a file can never shadow them (tested with files named
  `ready` and `fair/chains`). A directory with no `index.html` is a `BootError`, raised before a
  chain is drawn.
- **A chain id per boot.** `CRASH_CHAIN_FIRST_ID=boot` (baked into the image) names a fresh store's
  first chain by the Unix second it was generated. On a host without a disk every boot is a fresh
  store, so every boot's chain has an id of its own and a verification link from before a restart
  names a chain the server no longer has — instead of the same coordinates on a different chain,
  reported verified. With a disk it applies once.
- **`#/verify/latest`** waits for the client's history and replaces itself with the newest
  verifiable round's own link — the one verification link that outlives a boot, so the README can
  carry it.
- **The live demo** (`render.yaml`): Render's free tier, Frankfurt, deployed only after CI passes,
  with the network lab on (`CRASH_FAULTS=on`) and a 100,000-link chain rotating with 10,000 left. In
  Docker at the free tier's limits (`--cpus=0.1 --memory=512m`) a million-link chain took 85 s to
  build at boot and this one 8.7 s; the server answers `/ready` ≈20 s after start. A sleep and a
  wake were rehearsed the same way — the container removed and a new one started under an open
  page: the page reconnected by itself when the new instance came up, onto a new chain with a new
  commit and a fresh 1,000.00 wallet for the token it held.
- **The E2E suite** (`e2e/`, Playwright, Chromium) runs in CI after everything else, against
  `apps/server` in development serving the `--mode perf` build from its own origin — the deploy's
  shape, plus the dev hooks and a forced round:
  - `duel.spec.ts` — ROADMAP's two browser contexts in one round, forced to 3.00×: both bet through
    the real panel and see each other's stake; Ada presses past 1.50× and is paid within a hundredth
    of what her button promised; Bo rides it to the bust; both banners, both player lists and both
    history strips agree (the forced round drawn dashed); and every frame the two pages drew within
    8 ms of each other shows the same multiplier to the hundredth, none past the crash point.
  - `stranger.spec.ts` — ROADMAP's "Done when" as a test: a fresh context bets in the next window,
    has the server drop its socket from the network lab, sees the client say it is back with the
    bet still on the table, rides the round to the bust, follows the banner and gets every step
    verified — in under two minutes. It touches nothing but the page, so `E2E_BASE_URL=… pnpm
    e2e:live` runs it unchanged against the live demo.

**What P1 found.** The duel's first run failed its last assertion — a counter at 3.15× in a round
forced to 3.00× — and it was the test: the frame recorder started before the forced round, and the
round before it had climbed past 3×. Inside the forced round both pages heard the crash 3 ms after
`crashedAt` and drew their last frame at exactly 3.00×. Pairing frames within 2 ms, as `perf:web`
does, found 134 to 879 pairs per run depending on how two pages' frames happened to align, so the
suite pairs within half a frame (8 ms, where the curve rises at most 0.36 hundredths below 3×).
`@fastify/static` sets `cache-control: public, max-age=0` itself and overwrote the headers above
until told not to (`cacheControl: false`). And the first README GIF was a forced round — honest,
and captioned on screen "forced round (dev) · not verifiable", which is the wrong thing for a
reviewer's first look; it is now a real chain round from a dev seed picked so round 7 crashes at
3.37×, and the verification at its end is of that round.

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
| Panel | `apps/web`: stake and multiplier parsing (digit by digit, refusing a third decimal) · every panel mode and every disabled state with its reason | ✅ C2 |
| Verifier | `apps/web`: `verifyRound` against a scripted server — an honest round walked in slices, round 1, the browser's own knowledge (the crash point it was shown; commit, salt and edge from `hello`; another chain or none is unknown, not failed), a wrong crash point, a forged seed, a self-consistent round from another chain, a seed claimed at the wrong index, every refusal with its message, an abort mid-walk · `tableModel`, `gradeOf`, the hash route and what a stranger pastes · `fair`: `crashPointTrace` is `crashPoint` with its working, `hashTimes` in slices equals one walk | ✅ C3 |
| Play (C2 gate) | `pnpm play:web` — at least 30 rounds (on until 8 manual cash-outs, at most 60) in real Chromium on a 300 ms link, the bot typing and clicking the real panel (below) | ✅ C2 |
| Verify (C3 gate) | `pnpm verify:web` — a stranger loses a round and verifies it; four lying servers; a million-link walk (below) | ✅ C3 |
| Perf (C1 gate) | `pnpm perf:web` — two real Chromium pages, a forced 100× round, a 5 s stall on the phone's own socket (below) | ✅ C1 |
| Soak | `tests/soak.test.ts` — 200 players, 10 virtual minutes of stalls, dark links, storms, slow, lossy and hour-off clients against the real server; money audited every second, every player held to the engine at the end · `tests/hostile-clock.test.ts` — a client lying about its clock paid exactly what an honest one is | ✅ P0 |
| Load (P0 gate) | `pnpm load` — 500 players, 30 minutes, real sockets, a server process on SQLite, the soak's faults and a storm every 5 minutes, held to `/dev/audit` (below) | ✅ P0 |
| Integration | `apps/server` on a random port with real `ws` clients: two players in one round with the reveal verified against the published commit, and a latecomer's `history` pointing at it (D16), a forced round's at nothing · restart mid-round and after the crash moment (SQLite) · production dropping dev frames · a forced round claiming no link · faults on one connection only, a stall delivering late and in order · a half-open socket terminated by the heartbeat · `/dev/audit` in development only, with nothing secret · the wire's refusals · `betId` single-use across rounds · the log leak check. Plus the store contract (memory and SQLite, including across a reopen), the codec, the chain book, the boot contract and the fault lane (in order under loss, a stall, a late timer) | ✅ S3 · P0 |
| Integration (P1) | `apps/server` serving a web directory beside the API: `/` `no-cache`, a hashed asset `immutable`, `/ready` and `/fair/chains` never shadowed by files of those names, the socket upgrade on the same port, a 404 for a missing file; a directory with no `index.html` refused before a chain is drawn; `CRASH_CHAIN_FIRST_ID=boot` naming the chain by the boot second in `/fair/chains` and `hello` · `ChainBook` numbering a rotation after a boot-named chain, and never renaming a stored one · `#/verify/latest` and `latestLink` | ✅ P1 |
| E2E | `pnpm e2e` — Playwright in CI: **two browser contexts in one forced round**, one cashing out and one busting, frame for frame on the same multiplier; a stranger who bets, is dropped, recovers and verifies the round (below) | ✅ P1 |

What `pnpm e2e` measured (2026-10-01, local runs):

**P1 E2E** · headless Chromium, 1280×900 · `apps/server` in development serving the `--mode perf` build

| Measure | Result |
| --- | --- |
| Duel: frame pairs within 8 ms / worst disagreement | 879 / 1 hundredth (two runs; at 2 ms: 134–879 pairs, worst 1) |
| Duel: Ada's manual cash-out | paid 1.50×, within a hundredth of the button's promise (asserted) |
| Duel: highest counter either page drew in a round forced to 3.00× | 3.00× |
| Duel: crash heard after `crashedAt`, both pages | 3 ms |
| Stranger: open → verified (round crashed at) | 10.7 s (1.82×), 13.2 s (2.65×), 6.7 s (1.00×) |
| Stranger, against the production image at `--cpus=0.1 --memory=512m` | 16.0 s (1.45×) |
| Page errors, every run | 0 |

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

What `pnpm play:web` measured (2026-09-30):

**C2 play** · 30 rounds · 300 ms round trip (devFaults) · real panel, real Chromium

| Measure | Result |
| --- | --- |
| Manual cash-outs paid | 9 |
| … paid minus the button's promise: mean / max | 0.00 / 0 hundredths |
| … paid minus what the curve showed at the press: mean / max | 4.67 / 7 hundredths |
| Manual presses that arrived after the crash (TOO_LATE) | 0 |
| Rounds that crashed before the bot's target (busted, no press) | 5 |
| Auto cash-out rounds / paid exactly the target when it was reached | 16 / 9 |
| Auto cash-outs off "wins iff target ≤ crash point, pays the target" | 0 |
| Bets that missed betting (click landed after the close) | 0 |

On localhost the injected latency is exact, so "0 hundredths off the promise" is the best case; real
jitter moves the landing by the curve's rise over the jitter, which is **P0**'s to measure.

What `pnpm verify:web` measured (2026-10-01):

**C3 verify** · a stranger's lost round, verified in headless Chromium (390×844, mobile)

| Measure | Result |
| --- | --- |
| The stranger's bet | LOST at 1.49× |
| Round 2 from the banner: verdict / steps 2–5 | verified / ok ok ok ok |
| … click to verdict | 359 ms |
| The newest round from the history strip | verified |
| A server that sends a crash point the seed does not produce | does not verify (step 3) |
| A server that sends a forged seed | does not verify (steps 2–4) |
| A server that passes off the previous round's seed as this one | does not verify (steps 2–4) |
| A server that swapped the commit after the browser joined | does not verify |
| A round not yet revealed | refused by the server (404), no seed |
| Chain index 999,999 of a 1,000,000-link chain | verified |
| … the walk in the page | 999,999 hashes in 1347 ms |
| … longest gap between frames during the walk | 16.7 ms over 100 frames |
| Page errors, whole run | 0 |

The layout change re-ran the earlier gates the same day: C1 held 0 frames over 25 ms (max
13.0 ms); C2 paid every manual cash-out exactly its promise, once on a run that then failed for
having 7 samples rather than 8 — the next run had 8.

What `pnpm load -- --clients 500 --minutes 30` measured (2026-10-01):

**P0 load** · 500 players · 30 min · real sockets, a server process on SQLite · one machine

| Measure | Result |
| --- | --- |
| Money: granted = accounted, audited every 30 s | 60 audits, 0 breaches |
| Players in a wrong state at the end | **0 of 500** |
| Bets accepted / manual cash-outs / auto cash-outs / cancels | 39,531 / 5,333 / 6,469 / 3,113 |
| Reconnects / resyncs, whole crowd | 1,371 / 0 |
| `receivedAt` stamp, clean link (p50 / p99 / max): quiet server | 1 / 2 / 2 ms |
| … under 500 players | 0 / 4 / 65 ms (n = 105,456) |
| … during a reconnect storm | 0 / 3 / 8 ms |
| Tick fan-out, clean link: quiet server | 1 / 3 / 3 ms |
| … under 500 players | 3 / 9 / 29 ms (n = 136,202) |
| … during a reconnect storm | 2 / 8 / 12 ms |
| Reconnect storms (200 of 500 dropped mid-round, six of them): all back live in | 0.6, 0.6, 0.9, 0.6, 0.6, 0.6 s |
| Betting window left when `bettingOpen` lands — clean / far / lossy (p50) | 6.99 / 6.84 / 6.95 s |
| Bets refused `BETTING_CLOSED` — clean / far / lossy | 4 of 23,231 / 4 of 8,267 / 49 of 8,074 |
| Manual presses `TOO_LATE` — clean / far / lossy | 13 / 42 / 126 |

The stamp is the ADR-0002 promise under load: the loaded p99 is 2 ms above the quiet one (the gate
allows 10). Its 65 ms maximum is one sample in a hundred thousand — a collection pause or an fsync,
on a machine the clients share — and at 10× a 65 ms-late stamp is worth about ten hundredths.
The bots bet at a random moment in the first two-thirds of the window and do not heed the panel's
last call, so the lossy refusals are resends that outran it — the case `lastCallAt` exists for.
The earlier gates were re-run on P0's code the same day. `perf:web` now stalls the phone with
`devStall`, which releases the five seconds it held in one burst, as a stalled TCP connection
does — and the frame that takes it in is the run's one frame over 25 ms (36 ms of 3,681; the gate
holds). C1's latency trick had spread the backlog out, which is why it measured none. `play:web`
paid all 8 manual cash-outs exactly their promise over 32 rounds; `verify:web` was unchanged.

The lossy window's worst case (8.0 s, p99 7.1 s) is a client a few seconds after a reconnect:
its five-ping burst sat behind one resent frame together, so even the fastest of the five was
late; the 5-second pings that follow are independent and the offset settles.

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
| `pnpm e2e` | builds the server and the `--mode perf` web app, then the Playwright suite against a local server. **CI runs it after `check`** |
| `E2E_BASE_URL=<url> pnpm e2e:live` | the stranger spec alone, against any deployed copy — no server started |
| `docker build -t crash . && docker run --rm -p 8080:8080 -e CRASH_FAULTS=on crash` | the image the live demo runs, on <http://localhost:8080/> |

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
target). `pnpm perf:web` builds everything, then measures the C1 gate in real Chromium (below);
`pnpm play:web` the C2 gate and `pnpm verify:web` the C3 gate, the same way. `pnpm load -- --clients
500 --minutes 30` builds the server and `tools/load`, starts a development server process on a
temporary SQLite file and runs the P0 gate against it (below).

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

- **The salt is fixed, not beacon-derived.** docs/protocol.md §3.3 records it: a real-money operator
  would take each chain's salt from public randomness published after the commit, so `s₀` could not
  be ground for a favourable chain. Accepted for a play-money demo; revisit only if the project
  ever claims more than that.
- **Nothing has run on a real phone.** Every frame-time number here is headless Chromium on a desktop
  (`perf:web` throttles the CPU 4× and emulates a 375×812 DPR-3 screen; the verifier's million-hash
  walk is ≈1.3 s there, a mid-range phone perhaps 3–5× — the demo's 100,000-link chain is a tenth of
  that walk). The live demo is the place to try one; P1 could not, from here. A cell network's
  jitter moves a press's real landing by the curve's rise over the jitter, off the `rtt/2` the
  button prices — P0's lanes simulate latency and resends, not jitter. **Accepted, open.**
- **The load test shares the machine with the server.** `pnpm load` runs 500 clients in one Node
  process beside the server's, so its fan-out and stamp numbers include contention for the same
  cores — an upper bound on what the server costs, not a capacity figure. The live demo is not the
  place to measure capacity either: a tenth of a CPU, shared. **Accepted, open.**
- **The client bundle is 101 KB gzipped**, most of it React and zod. The dev message *schemas* ride
  along (a top-level zod call is not provably pure, so the bundler keeps it) — inert, since the
  client never sends one and the server decides whether to listen; the dev *hooks* and
  `__ASSERT_CURVE__` are stripped (checked by grepping the production bundle). Splitting
  `@crash/protocol/dev` would save a few KB. **Accepted.**
- **The browser remembers one session's chain.** Step 5 of the verifier compares against the
  commit, salt and edge from *this* page's `hello`; after a reload the browser knows only the
  current chain's. Persisting every commit a browser has been handed (`localStorage`, keyed by chain)
  would let a returning player hold the server to an older commit — but on the live demo the server
  forgets every older chain at its next sleep anyway (ADR-0003), so the page could compare and then
  have nothing to fetch. **Accepted** for this host; worth doing on one with a disk.
- **A verification link opened cold joins the table.** The verifier lives in the game's app, so a
  stranger following a link gets a socket and a play-money wallet they never asked for — which is
  also what lets step 5 compare against a `hello`, and costs nothing on a demo whose wallets last a
  boot. **Accepted.**
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
