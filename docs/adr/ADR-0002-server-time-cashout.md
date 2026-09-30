# ADR-0002 — Cash-out resolves on server receive time

- **Status:** accepted
- **Date:** 2026-08-17
- **Applies to:** `packages/engine`, `packages/client-core`, `apps/server`, the whole cash-out UX.

## Context

A player presses **Cash out** while the multiplier is climbing. Between the press and the server
there is a network — 20 ms on a desk, 300 ms on a train — and the multiplier moves the whole time.
Someone has to decide *which* multiplier the player got.

Three candidates:

1. **Client-reported multiplier.** The client says "I cashed out at 4.21×".
2. **Client timestamp**, converted by the server through the clock offset it already tracks.
3. **Server receive time.**

(1) is unshippable — it is a number the player's machine chose, for money, and the obvious exploit
is to always report the tick before the crash. (2) looks fairer and is worse than it sounds: the
offset is client-supplied input laundered through a formula, so shifting your clock shifts your
payout. Both make latency a thing to manipulate rather than a thing to compensate for.

## Decision

**A cash-out is worth the multiplier at the moment the server received the message, and nothing
else.**

Concretely:

- On `cashOut`, the server stamps `receivedAt` from its own monotonic clock, computes
  `m = curve(receivedAt − round.startedAt)`, and pays `floor(stake × m / 100)` in minor units — `m` in hundredths of 1×, as on the wire.
- If `receivedAt` is at or after the crash moment, the cash-out **loses**, and the response says so
  in the `PLAYER` error class ([`docs/protocol.md`](../protocol.md) §6). Late is late; there is no
  grace window, because a grace window is just a slower crash point.
- The client's on-screen multiplier is explicitly **a prediction**, not a promise. `client-core`
  knows the measured round-trip time and the UI shows the player what their press is likely to land
  on — the honest version of "your ping costs you 0.03×".
- **Auto cash-out is the answer to latency, and it is server-side.** A bet may carry
  `autoCashOutAt`; the server schedules it against the round clock and executes it at exactly that
  multiplier, with no message in flight at the deciding moment. This is why the feature exists in
  every crash game — not convenience, physics.
- Cash-outs are resolved in `receivedAt` order within a round, and the ordering is part of the
  broadcast so every client sees the same sequence.
- `cashOut` is idempotent on `betId`: a retry after a timeout returns the original resolution rather
  than paying twice or losing a winning press.

## Consequences

**Good**

- Nothing the client controls affects the payout. Clock skew, a patched bundle and a replayed packet
  all resolve to the same number.
- The engine stays pure and testable: given a round start, a crash point and a list of
  `(betId, receivedAt)`, the settlement is a total function with no ambiguity to argue about.
- It gives auto cash-out a real reason to exist, and gives the UI a genuine job — surfacing latency
  instead of hiding it.

**Costs, accepted**

- High-ping players are measurably worse off on manual presses. That is real, and the mitigation is
  disclosure plus auto cash-out, not a fudge factor.
- The multiplier a player saw when they pressed is usually *not* the one they get. The UI has to
  make that legible before it happens, or it reads as a bug every single time.
- The server must timestamp on receive, before any queuing or parsing work, or its own load turns
  into a payout difference under stress. This is a load-test assertion in **P0**, not a comment.

## Alternatives rejected

- **Trust the client multiplier.** Free money for anyone with a debugger.
- **Client timestamp with server-tracked offset.** Turns the clock-sync handshake into an attack
  surface for the sake of an accuracy nobody asked for.
- **Optimistic local resolution, reconciled later.** Means showing a player a win and taking it back
  — the single worst moment a gambling UI can produce.
- **Freeze the multiplier client-side on press and pay that.** Same as (1) with extra steps.
