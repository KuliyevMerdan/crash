/**
 * The dependency graph in CLAUDE.md § Dependency rules, enforced.
 *
 * Every workspace unit has two spellings that must both be matched, because one that has not been
 * built yet cannot be resolved to a file: `packages/<name>/…` (resolved) and `@crash/<name>`
 * (unresolved). The leading `(\.\./)*` is what lets `config/fixtures/` prove these rules fire: a
 * cruise rooted there reports a unit as `../../packages/<name>/…`, and a rule that only matched the
 * unprefixed spelling would pass the fixtures for the wrong reason.
 */
const WORKSPACE = '^(\\.\\./)*((packages|apps|tools)/[^/]+/|@crash/[^/]+$)';

/** Matches only the named workspace units, in either spelling. */
const only = (...names) =>
  `^(\\.\\./)*((packages|apps|tools)/(${names.join('|')})/|@crash/(${names.join('|')})$)`;

const list = (names) => names.map((n) => `@crash/${n}`).join(', ') || '(nothing)';

/**
 * `from` a unit, `to` anywhere in the workspace that is not on its allow-list. A unit may always
 * reach its own modules; the rule is about what crosses a boundary.
 */
const mayOnlyDependOn = (where, name, ...allowed) => ({
  name: `${name}-deps`,
  comment: `@crash/${name} may only depend on: ${list(allowed)} — CLAUDE.md § Dependency rules.`,
  severity: 'error',
  from: { path: `^${where}/${name}/src/` },
  to: { path: WORKSPACE, pathNot: only(name, ...allowed) },
});

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'A cycle between units means the boundary is not real.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },

    // The graph, one allow-list per unit.
    mayOnlyDependOn('packages', 'protocol', 'money'),
    mayOnlyDependOn('packages', 'money'),
    mayOnlyDependOn('packages', 'curve'),
    mayOnlyDependOn('packages', 'fair'),
    mayOnlyDependOn('packages', 'engine', 'protocol', 'money', 'curve', 'fair'),
    mayOnlyDependOn('packages', 'client-core', 'protocol', 'money', 'curve'),
    /**
     * `renderer` draws numbers and does not know what a message is — the seam that keeps the visual
     * layer testable without a socket. Its allow-list leaving out `protocol` IS that rule.
     */
    mayOnlyDependOn('packages', 'renderer', 'curve'),
    mayOnlyDependOn('apps', 'server', 'engine', 'protocol', 'money', 'curve', 'fair'),
    mayOnlyDependOn('apps', 'web', 'client-core', 'renderer', 'protocol', 'money', 'fair'),
    /**
     * The sim reads the game — the chain, the curve, the engine, the money it stakes and the config
     * type it runs under — and nothing that serves or draws it. S4 added `money` and `protocol` to
     * the planned three: a sim that cannot stake cannot measure a return.
     */
    mayOnlyDependOn('tools', 'sim', 'fair', 'curve', 'engine', 'money', 'protocol'),
    /**
     * The load test is a crowd of real clients and the wire: it judges the server by the server's
     * own account (`GET /dev/audit`), never by an engine of its own running beside it (P0).
     */
    mayOnlyDependOn('tools', 'load', 'client-core', 'protocol', 'money', 'curve'),

    // The hard rules on top of the graph.
    {
      name: 'nothing-imports-apps',
      comment:
        'An app composes packages; nothing composes an app. Not a package, a tool, or the other app.',
      severity: 'error',
      from: { path: '^(packages|tools|apps)/([^/]+)/' },
      to: {
        path: '^(\\.\\./)*(apps/[^/]+/|@crash/(server|web)$)',
        pathNot: '^apps/$2/',
      },
    },
    {
      name: 'no-slots',
      comment:
        'This repository is standalone: nothing from ../slots, by path or by package name. A "just this one type" copy is how two projects quietly become one.',
      severity: 'error',
      from: {},
      to: { path: '^(\\.\\./)+slots(/|$)|^@slot/' },
    },
    {
      name: 'packages-no-node-builtins',
      comment:
        'Every package either runs in the browser or must be able to — fair on the verification page, curve in the renderer, engine under a purity rule that forbids I/O. Node belongs to apps/server and tools/sim.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'packages-no-server-libs',
      comment:
        'The socket server, the HTTP framework, the logger and the database belong to apps/server. The engine returns effects; it never emits (CLAUDE.md).',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '(^|/)(ws|fastify|@fastify|pino|better-sqlite3)(/|$)' },
    },
    {
      name: 'react-stays-in-web',
      comment:
        'apps/web is the only React code. The renderer is raw Canvas 2D — "No React" (CLAUDE.md).',
      severity: 'error',
      from: { path: '^(packages|tools|apps/server)/' },
      to: { path: '(^|/)(react|react-dom)(/|$)' },
    },
    {
      name: 'no-cross-package-deep-imports',
      comment:
        'Reach another unit through its entry point, never into its src/. A unit with a real public surface is a unit with a real boundary.',
      severity: 'error',
      from: { path: '^(packages|apps|tools)/([^/]+)/' },
      to: { path: '^(\\.\\./)*(packages|apps|tools)/[^/]+/src/', pathNot: '^$1/$2/' },
    },
  ],
  options: {
    /**
     * `doNotFollow` rather than `exclude` for `dist/`, and the difference is the whole enforcement: a
     * workspace import resolves to the target's built entry point, and excluding `dist` would delete
     * that edge — so an illegal import would be caught only while it was undeclared, and adding the
     * dependency to package.json (the normal way anyone introduces one) would silence the rule.
     * The slot project learned this the hard way; it is a decision that repeats, not a module.
     */
    doNotFollow: { path: '(^|/)(node_modules|dist)(/|$)' },
    exclude: { path: '(^|/)\\.turbo(/|$)' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
  },
};
