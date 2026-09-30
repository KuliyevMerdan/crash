# Rule fixtures

These files are **deliberately illegal**. They exist so that [`tests/`](../../tests) can prove the
project's structural rules actually fire — a rule nobody has seen fail is a rule you are trusting,
not enforcing. `pnpm lint:boundaries` scanning the real workspace and finding nothing tells you
nothing on its own; these are the other half.

| Fixture | Proves | Enforced by |
| --- | --- | --- |
| `packages/renderer/src/illegal-protocol.ts` | the renderer cannot see a message — S0's "Done when" | [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs) |
| `packages/renderer/src/illegal-react.ts` | React stays in `apps/web` | `.dependency-cruiser.cjs` |
| `packages/renderer/src/legal.ts` | the renderer reading the curve is *not* flagged | `.dependency-cruiser.cjs` |
| `packages/engine/src/illegal-client-core.ts` | the engine knows nothing of the client | `.dependency-cruiser.cjs` |
| `packages/engine/src/illegal-ws.ts` | no package imports the socket server | `.dependency-cruiser.cjs` |
| `packages/engine/src/illegal-fs.ts` | no package imports a Node builtin | `.dependency-cruiser.cjs` |
| `packages/engine/src/illegal-deep-import.ts` | a unit is reached through its entry point, never its `src/` | `.dependency-cruiser.cjs` |
| `packages/engine/src/legal.ts` | the engine's whole allow-list is *not* flagged | `.dependency-cruiser.cjs` |
| `packages/fair/src/illegal-slots-package.ts` | nothing from `../slots` by package name | `.dependency-cruiser.cjs` |
| `packages/fair/src/illegal-slots-path.ts` | nothing from `../slots` by relative path | `.dependency-cruiser.cjs` |
| `apps/server/src/illegal-web.ts` | nothing imports an app | `.dependency-cruiser.cjs` |
| `apps/web/src/legal.ts` | the web shell's whole allow-list is *not* flagged | `.dependency-cruiser.cjs` |
| `tools/sim/src/illegal-server.ts` | the sim measures the engine, not the server | `.dependency-cruiser.cjs` |
| `packages/{engine,curve,fair,money}/src/impure.ts` | each pure package is held to the purity rules | [`eslint.config.mjs`](../../eslint.config.mjs) |
| `packages/curve/src/unsafe.ts` | no `any`, no `!`, no `as` in source — and `as const` stays legal | `eslint.config.mjs` |
| `packages/protocol/src/index.ts` | (legal) the target the deep-import fixture reaches into | — |

They are excluded from TypeScript, ESLint and Prettier in normal runs, and `pnpm lint:boundaries`
scans only `packages/`, `apps/` and `tools/`. Nothing here is compiled or shipped. The paths mirror
the real workspace because both rule sets match on path.

The `../slots` path fixture points at a module that does not exist, on purpose: it must resolve the
same way on a machine with the slot project checked out beside this one and on CI, where it is not.
