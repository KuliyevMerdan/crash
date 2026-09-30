# Crash — Roadmap

Drafted **2026-08-17**. A **real-time multiplayer crash game** — Node + TypeScript server, Canvas 2D
client, one WebSocket between them. Second portfolio project, standalone, sharing no code with
`../slots`. Target role: game client / frontend developer at an iGaming studio.

This file is the **task map**: blocks, their gates, and the order they land in. The *why* — the
committed crash point, server-time cash-out, the shared curve, the dependency rules — lives in
**[`CLAUDE.md`](CLAUDE.md)**, which is the canon you keep current as code lands.

**Every block follows the house pattern:**

> **protocol change → engine (headless tests) → server → client-core → renderer/UI → tests green →
> tick off here + update `CLAUDE.md` (Rule 0) and delete the filled Gaps entries (Rule 1)**

**S0 landed 2026-09-30** — the workspace, strict TypeScript, the dependency graph and purity rules
enforced and proven against illegal fixtures, CI. **S1 landed 2026-09-30** — the contract completed
(every payload defined, the chain's length and rotation decided) and the four packages that read
it: `protocol`, `money`, `curve`, `fair`. **S2 landed 2026-09-30** — `packages/engine`, the round
machine, conserving every minor unit over 10,000 seeded rounds. **S3 landed 2026-09-30** —
`apps/server`: the loop, SQLite persistence that resumes a round mid-flight, the fairness
endpoints, the dev surface. **S4 and C0 are next.**

---

## Task map

| Block | Delivers | Gates on | Status |
| --- | --- | --- | --- |
| **S0** | Workspace, strict TS, boundary lint, purity tests, CI | — | ✅ (landed 2026-09-30) |
| **S1** | `protocol` · `money` · `curve` · `fair` — the contracts everything reads | S0 | ✅ (landed 2026-09-30) |
| **S2** | `engine` — the round machine, pure and headless | S1 | ✅ (landed 2026-09-30) |
| **S3** | `apps/server` — Fastify + `ws`, the round loop, persistence | S2 | ✅ (landed 2026-09-30) |
| **S4** | `tools/sim` — crash distribution + realised house edge | S2 | ☐ |
| **C0** | `client-core` — socket, clock sync, reconnect, typed events | S1, S3 | ☐ |
| **C1** | The curve on screen — Canvas 2D, 60 fps, drift correction | C0 | ☐ |
| **C2** | Bet panel, cash-out, auto cash-out, latency disclosure | C1 | ☐ |
| **C3** | Player list, round history, the verification page | C1, S3 | ☐ |
| **P0** | Hardening — load, packet loss, clock drift, fault injection | C2, S3 | ☐ |
| **P1** | Packaging — deploy, README, Playwright E2E in CI | C3, P0, S4 | ☐ |

**Legend:** ☐ not started · ◐ in progress · ✅ landed (add the date, as `✅ (landed 2026-09-04)`).

**Build order:** `S0 → S1 → S2 → (S3 · S4 in parallel) → C0 → C1 → C2 → C3 → P0 → P1`.
S4 needs nothing after S2 and can fill any wait. C3's verification page needs `/fair/:index` from S3.

---

# Part I — Core & server

## Block S0 — Workspace foundations

_1 day. Nothing else may land before it._

- [x] pnpm workspace + Turborepo, `packages/*`, `apps/*`, `tools/*`, catalog-pinned tool versions.
- [x] Strict TypeScript — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
      `dist` builds per package. **Diverged:** no project references — units resolve through
      `dist/` + `exports`, ordered by Turborepo's `^build`, which references would only duplicate.
      The base tsconfig carries no DOM lib and no Node types; three flavours opt in.
- [x] `dependency-cruiser` encoding the graph in [`CLAUDE.md`](CLAUDE.md) § Dependency rules,
      **including the forbidden path to `../slots`** (by path and by `@slot/*` name) — plus no Node
      builtins or server libraries in any package, React only in `apps/web`, entry points only.
      `tests/boundaries.test.ts` proves every rule fires against `config/fixtures/`.
- [x] `tests/purity.test.ts` — no `Date.now`, `new Date`, `performance.now`, `Math.random`,
      `fetch` or `process` inside `engine`, `curve`, `fair`, `money`, one fixture per package. `fs`
      and `ws` are banned from every package by the boundary rules instead, which see imports.
      `tests/type-safety.test.ts` proves the `any` / `!` / `as` bans alongside.
- [x] ESLint + Prettier + husky/lint-staged; CI running `pnpm check` on push.
- [x] Ten empty packages — seven in `packages/`, two apps, one tool — whose `src/index.ts` names
      the block that fills each one.

**Done when:** `pnpm check` is green on an empty workspace, and a deliberately illegal import
(`renderer` → `protocol`) fails CI.

## Block S1 — Contracts: protocol, money, curve, fair

_2–3 days. Write this before anything moves on screen. Everything is downstream of it._

- [x] **The wire contract is pinned** (2026-08-17) — every message, both directions, the three-class
      error taxonomy, idempotency on `betId`, clock sync, and the decision log with rejected
      alternatives, in [`docs/protocol.md`](docs/protocol.md).
- [x] **The two load-bearing decisions are ADRs** (2026-08-17) —
      [ADR-0001](docs/adr/ADR-0001-committed-crash-point.md) (committed crash point, hash chain) and
      [ADR-0002](docs/adr/ADR-0002-server-time-cashout.md) (server receive time decides a cash-out).
- [x] **The contract completed first** — the payloads it named but never gave (`bettingOpen`,
      `roundStart`, the two bet-entry shapes, the `cancelBet` replies), `roundId` on every private
      reply as invariant 8 demands, `betRejected` retired for `error` (D8), the error codes
      enumerated per class, the curve in integer ms with an exact inverse (D9), the `1,000,000×`
      ceiling (D10), hashes as bare hex (D12).
- [x] `packages/money`: branded `Minor`, integer arithmetic, `Intl.NumberFormat` display — and a
      `payout` that refuses an inexact product rather than rounding it.
- [x] `packages/curve`: `m(t)` and `t(m)` in hundredths of 1×, with the round-trip property test
      and behaviour pinned at the boundaries (`t = 0`, every quantisation step to 100×, the
      ceiling). The inverse is walked to the exact boundary, not trusted to `ln`.
- [x] `packages/fair`: chain generation, reverse consumption, `HMAC → crashPoint`, `verifyLink`,
      `verifyToCommit`. **Isomorphic** — SHA-256 and HMAC in plain TypeScript, and a suite that
      runs in happy-dom.
- [x] Golden test: 30 pinned seeds → crash points, computed by an independent Python
      implementation, plus other edges and a chain.
- [x] `packages/protocol`: zod schemas + inferred types for all of §2, `GameConfig`, the round
      snapshot, the error union, the §3.3 HTTP shapes. `tests/protocol-doc.test.ts` holds the
      document's tables and the schemas to the same list.
- [x] **Chain length and rotation decided** — a million links, the next chain published with
      50,000 left, `GET /fair/chains` (docs/protocol.md §3.3, D11). The crash-point formula
      turned out to fix the instant-bust fraction analytically at exactly the edge (§3.2), so that
      gap closed too; S4 confirms it rather than tunes it.

**Done when:** a golden test pins the crash point for ~30 seeds, `fair` verifies a chain link in
both runtimes, and the protocol schemas parse a hand-written fixture of every message.

## Block S2 — The round machine

_2–3 days. The part reviewers actually read._

- [x] `packages/engine`: `step(state, event, now) → { state, effects }`. Phases as an exhaustive
      discriminated union with a total `switch`. **The engine returns effects; it never emits.**
      Every step settles what was due at its scheduled moment before judging the event, so a late
      timer changes nothing.
- [x] The crash moment computed **once** at round start via `t(crashPoint)`, then scheduled — not
      polled per tick ([`docs/protocol.md`](docs/protocol.md) §11, D5).
- [x] Bet placement with validation against config limits and balance; one bet per round;
      `cancelBet` during `BETTING` only.
- [x] Cash-out resolution on `receivedAt`, ordered within the round, `TOO_LATE` at and past the
      crash moment.
- [x] **Auto cash-out fires server-side at exactly `t(autoCashOutAt)`** and pays exactly its
      target, producing the same effects as a manual one with `reason: "AUTO"`.
- [x] Idempotency on `betId` for `placeBet`, `cancelBet` and `cashOut` — a replay returns the
      original answer, never a second bet and never a second payout — across the current and the
      previous round. Beyond that is S3's persistence ([`CLAUDE.md`](CLAUDE.md) § Gaps).
- [x] Settlement: every bet resolved exactly once at crash, balances authoritative, the reveal
      verified against its link before the round is even opened.
- [x] Tests: every transition and refusal · a cash-out one millisecond either side of the crash
      moment · two cash-outs racing on the same `betId` · auto and manual cash-out colliding ·
      10,000 seeded rounds with money audited after every step, every effect parsed against the
      wire schema, and every bet resolved exactly once.

**Done when:** a headless Vitest run plays 10,000 seeded rounds with bets, auto cash-outs, retries
and late presses, and the sum of all balances plus house take is exactly conserved — with no socket
anywhere in sight.

## Block S3 — `apps/server`

_2–3 days._

- [x] Fastify + `ws`. Every inbound frame parsed with its `@crash/protocol` schema before it reaches
      the engine; unknown types dropped, malformed ones answered.
- [x] The round loop: `BETTING → RUNNING → CRASHED → pause → BETTING`, one timer armed at the
      engine's `nextDeadline`, the monotonic clock handed in. Every change is step → persist (one
      transaction) → publish.
- [x] **`receivedAt` stamped on frame receipt, before parsing or queuing** — the first line of the
      handler. (That it holds *under load* is P0's assertion.)
- [x] Broadcast: ticks every 100 ms, `betPlaced` / `playerCashedOut` fan-out, `crash` with the reveal.
- [x] Persistence behind one interface, in-memory + SQLite, one contract suite. The engine is a
      checkpoint per crash plus a journal replayed through the pure engine on boot. **Chain state
      survives restart** and resumes at the next unconsumed index — and so does the round in flight.
- [x] `GET /fair/chains` and `GET /fair/:chainId/:chainIndex` for the verification page
      (docs/protocol.md §3.3); `/health` and `/ready` (naming the failed check).
- [x] Server-side fault injection (latency, drop, disconnect) on the sender's own connection, and
      dev-gated `forceCrashPoint` — both pinned in docs/protocol.md §9 and `packages/protocol` (D13:
      a forced round claims no chain link) — with the test that a production-mode server drops a
      hand-crafted frame carrying either.
- [x] Structured logs (pino) correlated on `roundId`; **a test that no log line before a crash
      contains its seed, and none ever contains `s₀`.**
- [x] The boot contract: production refuses an in-memory store, a missing database and a dev chain
      seed, naming every violation at once.

**Done when:** two `wscat` sessions join the same round, one cashes out and one doesn't, the crash
reveal verifies against the chain commit, and a restart mid-round resumes the chain correctly.
**Met 2026-09-30** — as tests rather than by hand (`apps/server/src/server.test.ts`): two real `ws`
clients in one round, the reveal checked against `GET /fair/chains` the way a stranger would, and
two restarts on SQLite — mid-round, and after the crash moment had passed.

## Block S4 — `tools/sim`

_1 day. Gates only on S2 — good filler work._

- [ ] Run N rounds headlessly through `engine` + `fair`, no server, no sockets.
- [ ] Report: crash distribution against the theoretical `P(crash ≥ m) ≈ 0.99/m`, realised house
      edge, median and p99 crash point, longest observed streak below `2×`.
- [ ] **Confirm the edge empirically** — the instant-bust fraction and the realised edge both
      equal `houseEdgeBps` by derivation (docs/protocol.md §3.2); pin that with a tolerance test in
      CI at a smaller N, so a regression in `fair` shows up as a number, not a hunch.
- [ ] Simulate flat strategies (always `1.5×`, always `2×`, always `10×`) and show they converge to
      the same expected value minus edge — the claim from the README, made checkable.

**Done when:** a 10⁶-round run reports realised edge within tolerance of the configured value, and
the strategy comparison prints a table you would put in the README.

---

# Part II — Client

## Block C0 — `client-core`

_2 days. **No DOM in this package.**_

- [ ] WebSocket client with typed message parsing on the way in, a typed event stream on the way out.
- [ ] **Clock sync** — `ping`/`pong`, median-of-5 offset, re-sample every 30 s, `rtt` exposed
      separately ([`docs/protocol.md`](docs/protocol.md) §8).
- [ ] Reconnect with exponential backoff; `authenticate` → `hello` → full state restored. **No
      recovery call, no replay** — learn `startedAt` and the curve follows.
- [ ] Liveness: three missed `pong` intervals triggers a reconnect.
- [ ] Idempotent send: a `placeBet` retried after a timeout reuses its `betId`; a `SYSTEM` error
      never re-issues under a new one.
- [ ] Tests against a fake socket: reconnect during each phase · a `hello` for a round that started
      before the client existed · clock offset under asymmetric latency · a duplicate `betAccepted`.

**Done when:** a headless test disconnects the client at 20 random points across 100 rounds and
every reconnect lands in the correct phase with the correct bets, balance and multiplier.

## Block C1 — The curve on screen

_3 days._

- [ ] `apps/web` bootstrap: Vite + React shell, `client-core` wired, connection states that are
      real UI (connecting / reconnecting / desynced) rather than a spinner.
- [ ] `packages/renderer`: Canvas 2D, delta-time driven, drawing from `curve(now − startedAt)` at
      60 fps. **Ticks correct drift; they do not drive frames.**
- [ ] **Viewport rescaling** — the exponential leaves the screen within seconds. Axis compression as
      the multiplier climbs, smooth, never a jump ([`CLAUDE.md`](CLAUDE.md) § Gaps).
- [ ] The counter: large, readable, quantised to the same hundredths as the wire so it can never
      show a number the server would disagree with.
- [ ] The crash: the curve breaks, the counter freezes red, the reveal appears. Then the pause and
      the countdown to the next round.
- [ ] `__ASSERT_CURVE__` in dev builds — throw on any tick disagreeing by more than one step (0.01×).

**Done when:** it holds 60 fps on a throttled mobile profile through a `100×` round, survives a
5-second network stall mid-curve without a visual jump, and two browsers side by side show the same
multiplier to the naked eye.

## Block C2 — Betting, cash-out, latency

_2–3 days._

- [ ] Bet panel: amount stepper against config limits, place during `BETTING`, cancel before it
      closes, disabled states that explain themselves.
- [ ] The cash-out button as the centre of the UI — stake, current value, one press.
- [ ] **Latency disclosure.** The button shows what the press will *actually* land on given measured
      `rtt`, before it is pressed ([ADR-0002](docs/adr/ADR-0002-server-time-cashout.md)). Getting a
      multiplier you didn't see must never feel like a bug.
- [ ] Auto cash-out input, with the honest explanation of why it is more accurate than a press.
- [ ] Balance HUD driven **only** by authoritative balances from the wire. Never computed locally.
- [ ] The result moment: won at `4.21×` / busted, unmissable, and gone before the next round opens.

**Done when:** you can play thirty rounds on a 300 ms throttled connection without ever being
surprised by the multiplier you got.

## Block C3 — Players, history, verification

_2 days._

- [ ] Live player list: nick, stake, and the multiplier each one got, filling in as they cash out.
      **Never `autoCashOutAt`** ([`docs/protocol.md`](docs/protocol.md) §11, D4).
- [ ] Round history strip — the last ~30 crash points, colour-graded, clickable.
- [ ] **The verification page.** Paste a round, see the seed, the chain link, the HMAC and the
      recomputed crash point — running `packages/fair` **in the browser**, the same code the server
      used. Walk the chain back to the published commit.
- [ ] The 18+/play-money notice, and a short "how this works" panel linking the ADRs.

**Done when:** a stranger can pick a round they just lost, verify it in the browser, and see for
themselves that the result predated their bet.

---

# Part III — Hardening & packaging

## Block P0 — Hardening

_2 days._

- [ ] Load test: 500 concurrent sockets in one round. Measure broadcast fan-out latency and assert
      **`receivedAt` accuracy does not degrade under load** — the ADR-0002 promise, tested.
- [ ] Packet loss and stalls: 20% drop, 3-second freezes, half-open connections. The client must
      recover without a visible jump and without a wrong balance.
- [ ] **Clock drift and hostile clocks**: a client with a clock an hour off must play correctly, and
      must not be able to affect a payout by lying about time.
- [ ] Reconnect storm — 200 clients reconnecting at once mid-round.
- [ ] Measure whether `bettingPhaseMs = 7000` is enough for a 300 ms client
      ([`CLAUDE.md`](CLAUDE.md) § Gaps) and set the real value.
- [ ] Debug panel exposing the server's fault injection, so a reviewer can break the network on the
      live demo and watch it recover.

**Done when:** a 500-client 30-minute soak with injected faults ends with zero money created or
destroyed and zero clients in a wrong state.

## Block P1 — Packaging

_1–2 days._

- [ ] Deploy server + web (Fly / Railway), SQLite on a volume so the chain survives a redeploy.
- [ ] Playwright E2E in CI with a forced crash point: **two browser contexts in one round**, one
      cashing out, one busting, both asserting the same multiplier at the same moment.
- [ ] README with a GIF above the fold, the two ADRs summarised in a paragraph each, the house-edge
      table from S4, and a link to a round anyone can verify.
- [ ] `docs/architecture.md` — the round loop, the clock, and the one diagram that explains why the
      client draws its own curve.

**Done when:** a stranger can open the live link, play a round, break the network from the debug
panel, watch it recover, and verify the result they just got — in under two minutes.
