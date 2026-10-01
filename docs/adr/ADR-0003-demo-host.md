# ADR-0003 — The demo host: one origin, no disk, a fresh chain each boot

- **Status:** accepted
- **Date:** 2026-10-01
- **Applies to:** `apps/server` (static serving, the boot chain id), the `Dockerfile`, `render.yaml`,
  the verifier's links. **Amends** [ADR-0001](ADR-0001-committed-crash-point.md) for a host without
  a disk.

## Context

The live demo has to cost nothing to keep up and need no card: it is a portfolio piece, and a demo
that lapses when a trial ends is worse than none. ROADMAP P1 planned Fly or Railway with SQLite on a
volume. The free tier this portfolio can actually use is Render's — the slot project has run on it
since 2026-09-26 — and it has two properties that matter here:

1. **No persistent disk.** The container's filesystem is new at every boot.
2. **It sleeps.** After 15 minutes without a request the instance stops; the next visitor wakes a
   new one in about a minute. It also has a tenth of a CPU.

ADR-0001 says chain state is persisted and a restart resumes at the next unconsumed index: "a
regenerated chain silently breaks every past verification". On this host nothing is persisted, so
something has to give. The tempting fix is to keep `s₀` as a secret in the host's environment, so
every boot rebuilds the same chain. **That is the one option that is actually unsafe**: without a
durable consumed index, each boot would start the chain from round 1 again and replay seeds that
were already revealed in public — every crash point of the replayed rounds known to anyone who was
watching. Reusing a chain without its cursor is worse than not having one.

## Decision

**On a host without a disk, every boot is a new table: a new `s₀` from the CSPRNG, a new published
commit, fresh play-money wallets, an empty history.** Nothing claims to survive a boot, so nothing
silently fails to.

- **One origin.** `apps/server` serves the built web app from `/` (`CRASH_STATIC_DIR`) beside `/ws`
  and `/fair/*`, so the page needs no CORS, no server address and no proxy — the same shape in the
  Docker image, in the E2E suite and on Render. Hashed assets are cached for a year; `index.html`
  never, so a returning browser always runs the client that matches the server.
- **A chain id per boot.** A fresh store names its first chain by the Unix second it was generated
  (`CRASH_CHAIN_FIRST_ID=boot`, baked into the image). Without this every boot's chain would be
  chain 1, and a verification link from before a sleep — `#/verify/1/14` — would open round 14 of a
  *different* chain and report it verified: correct about the round it checked, wrong about the
  round the reader meant. With it, an old link names a chain the server no longer has, and the page
  says so. On a host with a disk the same setting applies once, at the store's first boot.
- **A stable link that does not depend on a boot**: `#/verify/latest` opens the newest finished
  round, whatever chain it is on. The README points at it.
- **A shorter chain.** At a tenth of a CPU a million-link chain takes 85 s to build at boot; the
  demo uses 100,000 (8.7 s; ready in ~20 s), which at ~13 s a round lasts two weeks of continuous
  play — far longer than any awake period — and rotates with 10,000 left (`render.yaml`).
- **Deploys follow CI.** `autoDeployTrigger: checksPass`: the demo is never a commit that
  `pnpm check` or the E2E suite rejected.

## Consequences

**Good**

- The fairness claim stays exactly as strong as ADR-0001 makes it, *within a boot*: every round is
  committed before it is played and verifiable in the browser against a commit published before
  the first bet, and no seed is ever revealed twice.
- Costs nothing, needs no card, and the image runs unchanged on a host with a disk — mount
  `/app/data` and the chain, balances and journal survive restarts as ADR-0001 intends.

**Costs, accepted**

- **A round is verifiable for as long as its boot lasts** — in practice until 15 minutes after the
  last visitor leaves. Its seed was published in the `crash` message and its commit in `hello`, so
  anyone who kept them can still check it offline with `@crash/fair`; the server just cannot serve
  them any more.
- **A wallet lasts a boot.** A returning browser's token is unknown to the new instance, and the
  client starts a new play-money wallet without complaint (tested: the open page reconnects on its
  own when the new instance is up). This also closes "sessions never expire" for the demo.
- **The first visit after a quiet spell waits for a cold start** — Render's minute plus ~20 s of
  boot. The README says so, so a reviewer does not take a slow first load for a broken page.
- **Rotation is untested in production**: no awake period will reach 90,000 rounds. It is tested in
  `chains.test.ts` and the server suite instead.
