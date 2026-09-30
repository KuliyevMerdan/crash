# ADR-0001 — The crash point is committed before the round, and revealed after

- **Status:** accepted
- **Date:** 2026-08-17
- **Applies to:** the whole repository. Every other decision is downstream of this one.

## Context

In a crash game the server decides when the multiplier busts. There are two ways to arrange that:

1. Roll continuously while the round runs — at every tick, decide whether to bust now.
2. Decide the crash point **before betting opens**, commit to it cryptographically, run the round
   against that fixed number, and reveal it afterwards.

(1) is what a naive implementation does, and it is indistinguishable — from the outside and from the
code — from a server that waits until a large bet is exposed and busts on it. There is no artefact a
player, an auditor or a regulator can check. The round is over, the number is gone.

This matters more here than in a slot. A slot outcome is private: you spin, you see your grid.
A crash round is **public and shared** — everyone watched the same curve and can compare notes — so
the honesty of the result is the product, not a footnote. It is also the one thing in this project a
stranger can verify in thirty seconds without reading any code.

## Decision

**The crash point of every round is determined before betting opens, from a seed the server
committed to in advance, and is revealed to every client when the round ends.**

Concretely:

- The server pre-generates a **hash chain** off-line: `s₀` random, `sᵢ₊₁ = SHA256(sᵢ)`, and
  publishes the **last** element as the chain commit. Rounds consume the chain **in reverse order**.
  Each revealed seed hashes into the previously revealed one, so the chain can be walked backwards
  to the commit by anyone and cannot be rebuilt or reordered after the fact.
- The crash point is a pure function of the round seed:
  `crashPoint = f(HMAC_SHA256(key = roundSeed, message = SALT))`, implemented once in
  [`packages/fair`](../../packages/fair) and used by nothing else to decide anything.
- **`fair` is isomorphic** — the same package runs on the server that produces the result and in the
  browser page where a player checks it. The verifier is not a re-implementation that can drift; it
  is the implementation.
- The seed is revealed in the `crash` message ([`docs/protocol.md`](../protocol.md) §2.7) and never
  before. A client holding the seed early would know the crash point before betting closed.
- Chain state is persisted. A server restart resumes the chain at the next unconsumed index — it
  never regenerates, because a regenerated chain silently breaks every past verification.
- The house edge lives **inside** the crash-point function as a documented constant, and
  [`tools/sim`](../../tools/sim) asserts it empirically over millions of rounds. Edge is not a fee
  applied elsewhere and not a thumb on the scale during a round.

## Consequences

**Good**

- The result is checkable without trusting the operator, the code, or this document. That is the
  claim the README leads with, and it is falsifiable.
- The round machine gets simpler, not harder: the engine compares a clock against a number it was
  handed. There is no RNG anywhere in the running round, so the engine is pure and its tests are
  deterministic.
- Bet exposure becomes irrelevant to the outcome by construction. There is no code path where it
  could matter, which is a much stronger statement than a policy saying it doesn't.

**Costs, accepted**

- The chain is a finite resource with real operational weight: it must be generated ahead, stored,
  consumed in order, and never regenerated. Exhausting or losing it is an incident, and the commit
  for a new chain has to be published before the old one runs out.
- The seed must be kept out of every message, log line and error payload until reveal. That is a
  leak with no recovery — one early seed invalidates the round for everyone.
- Pre-committing means the server cannot correct a round in flight, including one it started with a
  bad config. The fix is always to finish the round and change the next one.

## Alternatives rejected

- **Roll per tick.** Unverifiable by construction, and the exact shape a player accuses you of when
  they lose. Nothing is gained by it.
- **Reveal the seed at round start so clients can render the curve locally.** It would let every
  client know the crash point before cash-out — the game ends.
- **Commit per round instead of a chain.** A per-round commit proves the server didn't change its
  mind *within* a round, but not that it didn't pick the round's seed after seeing the bets. The
  chain removes that gap; a single hash published in advance covers every round it contains.
- **Trust the server, publish a monthly RTP report.** That is the industry's default and it is
  exactly the thing this project is a counter-example to.
