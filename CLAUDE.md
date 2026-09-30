# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project status

> ⚠️ **The workspace exists; the game does not.** **S0 landed 2026-09-30**: the pnpm + Turborepo
> workspace, strict TypeScript, the dependency graph and the purity rules enforced and *proven to
> fire* against deliberately illegal fixtures, and CI running `pnpm check`. All ten units exist as
> empty shells, each already policed. The wire contract ([`docs/protocol.md`](docs/protocol.md)) is
> pinned, ADR-0001 and ADR-0002 are accepted, and [`ROADMAP.md`](ROADMAP.md) maps the blocks.
> **S1 — the contracts: `protocol`, `money`, `curve`, `fair` — is next.**
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

All ten exist since **S0** as empty shells — a `src/index.ts` naming its block, a build to `dist/`,
and the dependency rules already applied. The right-hand column is the block that fills each.

| Package | Responsibility | Block |
| --- | --- | --- |
| `packages/protocol` | zod schemas + inferred types for every message in [`docs/protocol.md`](docs/protocol.md); the three-class error taxonomy | S1 |
| `packages/money` | branded `Minor`, integer arithmetic, `Intl.NumberFormat` display | S1 |
| `packages/curve` | `m(t)`, `t(m)`, quantisation to hundredths of 1×. Pure, tiny, load-bearing | S1 |
| `packages/fair` | hash chain, `HMAC → crashPoint`, chain-link verification. **Isomorphic** | S1 |
| `packages/engine` | the round machine — phases, bets, cash-out resolution, settlement. Pure | S2 |
| `packages/client-core` | WebSocket client, clock sync, reconnect, typed event stream out. **No DOM** | C0 |
| `packages/renderer` | the curve, the counter, the crash. Canvas 2D. **No React, no protocol** | C1 |
| `apps/server` | Fastify + `ws` — the round loop, broadcast, persistence | S3 |
| `apps/web` | Vite + React shell around `renderer` + `client-core` | C1–C3 |
| `tools/sim` | N-million-round run: crash distribution, realised house edge, RTP report | S4 |

**Canvas 2D, not Pixi** — deliberately. The slot project already demonstrates Pixi; a second WebGL
renderer adds nothing to read, and this game is one curve, one counter and a burst. Raw Canvas 2D is
the honest tool and shows the layer under the framework.

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
tools/sim ──▶ fair, curve, engine
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
`(state, event, now) → (state, effects)` and broadcasts the effects. **The engine never emits; it
returns.** That is what lets `tools/sim` run millions of rounds through the same code that serves
the demo, and what makes "the RTP you publish is the RTP you play" checkable rather than claimed.

Persistence sits behind one interface with two implementations: in-memory (tests, sim) and SQLite
(the deployed demo). The chain must survive a restart — a regenerated chain silently invalidates
every past verification ([ADR-0001](docs/adr/ADR-0001-committed-crash-point.md)).

### Testing layers

| Layer | What it proves | Block |
| --- | --- | --- |
| Unit | `curve` round-trips (`t(m(t)) ≈ t`), `fair` chain links, `money` arithmetic | S1 |
| Golden | the crash point for ~30 pinned seeds never changes | S1 |
| Engine | every legal transition, every illegal one rejected, idempotent replay, cash-out ordering | S2 |
| Statistical | `tools/sim` over ≥10⁶ rounds: `P(crash ≥ m) ≈ 0.99/m`, realised edge within tolerance of `houseEdgeBps` | S4 |
| Integration | a real socket, a real round, fault injection | S3, P0 |
| E2E | Playwright, **two browser contexts in the same round**, one cashing out, one busting | P1 |

The statistical layer is the one that would be missing from a weaker version of this project, and
it is the one that proves the house edge is where ADR-0001 says it is.

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

Still to come: `pnpm dev` (server + web, watch mode) with **S3/C1**, and
`pnpm sim -- --rounds 1000000` (distribution + house-edge report) with **S4**.

A pre-commit hook (husky → lint-staged) runs ESLint and Prettier over staged files. `turbo.json`
sets `agentGuidance: false`: Turborepo ≥ 2.11 otherwise writes an `AGENTS.md` whenever it detects an
AI agent, and this file is where the repository's guidance lives.

## Gaps & missing pieces

Log what you hit here as you hit it ([Rule 1](#rule-1--log-the-gaps-you-hit)). Open at time of
writing:

- **Chain length and rotation.** How many rounds per chain, and the operational story for publishing
  the next commit before the current chain runs out. Decide in **S1**, before the chain generator is
  written.
- **Exact crash-point constants.** The formula shape is pinned; the instant-bust fraction that
  realises `houseEdgeBps = 100` is not. **S4** settles it empirically — do not guess it in S1 and do
  not let S1 block on it.
- **Betting-phase length under real latency.** 7 s is a placeholder. **P0** measures whether a
  300 ms client can reliably place a bet in it.
- **Message payloads the contract names but does not define.** `round.bets` (§2.3) and
  `hello.myBets` (§2.2) point at bet-entry shapes no section gives; `bettingOpen` and `roundStart`
  have no payload; `betRejected` sits in the §2 table while §2.4 answers a refused bet with `error`;
  `cancelBet` has no reply. **S1** pins all of them in `docs/protocol.md` before the schemas are
  written — the document leads and the schemas follow, never the other way round.
- **The host versus a chain that must survive a redeploy.** P1 plans Fly or Railway with SQLite on a
  volume; the slot project (2026-09-26) found that the no-card free tier it could actually use —
  Render — has no persistent disk and sleeps after 15 idle minutes. Worth noting before P1 picks:
  the chain is fully determined by `s₀` and its length, so "never regenerate" means *never draw a new
  `s₀`* — `s₀` can live as a secret, and only the consumed index needs durable storage. **P1**
  decides the host and where that index lives.
- **What the curve looks like past ~20×.** Exponential growth leaves the viewport fast. Rescaling
  strategy is a **C1** question and it is a real design problem, not a detail.

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
