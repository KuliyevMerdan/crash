# Crash

A **real-time multiplayer crash game** — one round, every player in it at once, a multiplier that
climbs until it busts. Node + TypeScript on the server, Canvas 2D in the browser, WebSocket between
them.

> ⚠️ **Status (2026-09-30): the client core holds the round; nothing draws it yet.** **S0–S4 and
> C0** have landed: the workspace and its enforced boundaries, the wire contract as schemas, the
> curve, money and the provably-fair chain, the pure round engine, the server (a shared round over
> WebSocket, SQLite persistence that survives a restart mid-round, `GET /fair/*`), a million-round
> simulation in which every flat strategy returns 99%, and the client core — reconnect, clock sync,
> idempotent requests — held to the server through 20 dropped connections. See
> [`ROADMAP.md`](ROADMAP.md) — **C1**, the curve on screen, is next.

## What makes it interesting to build

Not the graphics. The synchronisation.

- **One round, shared by everyone.** The server owns the clock; every client renders the same
  multiplier at the same wall-clock moment, from tick messages ~100 ms apart.
- **The multiplier is a pure function of time**, so the client interpolates between ticks instead of
  waiting for them — and the same function ships on both sides, from one package
  ([`packages/curve`](packages/curve)).
- **Reconnect means joining a round already in flight**, not replaying your own. Learn the round's
  start timestamp and the whole state follows.
- **Cash-out is a race against a crash point fixed before betting opened**, resolved on server
  receive time — the only clock nobody can forge ([ADR-0002](docs/adr/ADR-0002-server-time-cashout.md)).
- **Provably fair, in the open.** A pre-committed hash chain consumed in reverse, revealed round by
  round, with a verification page where anyone recomputes the result themselves
  ([ADR-0001](docs/adr/ADR-0001-committed-crash-point.md)).

## Documents

| File | What it is |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | The canon — architecture, packages, rules. Kept current as code lands. |
| [`ROADMAP.md`](ROADMAP.md) | The task map — blocks, gates, `Done when`. |
| [`docs/protocol.md`](docs/protocol.md) | The wire contract — every message, both directions. |
| [`docs/adr/`](docs/adr) | The decisions that everything else is downstream of. |

Play money only. No real money, no payments, no crypto — a visible 18+/demo notice instead.
