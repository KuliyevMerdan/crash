// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * The purity rules from CLAUDE.md, as lint rules.
 *
 * `engine`, `curve`, `fair` and `money` take time as a parameter and randomness as a seed. That is
 * what lets `tools/sim` play a million rounds in seconds through the code that serves the demo, and
 * what lets `fair` run unchanged on the verification page. Ambient time or randomness anywhere in
 * them destroys both quietly — the tests keep passing, they just stop meaning anything.
 */
const PURE_PACKAGES = ['engine', 'curve', 'fair', 'money'];

const CLOCK =
  'Time is a parameter. Take `now` from the caller — ambient time makes replay impossible.';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'config/fixtures/**', // deliberately illegal — see config/fixtures/README.md
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Tooling config that has to stay CommonJS (dependency-cruiser loads it with `require`).
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // CLAUDE.md § Other rules: no `any`, no non-null `!`, no `as` outside a parser boundary. Source
    // only — a test may assert its way to a fixture. Values that cross a boundary are parsed with
    // zod, which returns the type, so the boundary itself needs no assertion either; where one
    // genuinely does, it carries an `eslint-disable-next-line` that says why. `as const` is not an
    // assertion about a value's type and stays allowed.
    files: ['**/{packages,apps,tools}/*/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    },
  },
  {
    // `**/` so the rule set also applies to config/fixtures/packages/… — the fixtures that prove
    // these rules fire (tests/purity.test.ts).
    files: [`**/packages/{${PURE_PACKAGES.join(',')}}/**/*.ts`],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'Randomness enters as a seed, from `fair`, drawn from the chain (ADR-0001).',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: CLOCK,
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: CLOCK,
        },
        {
          selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
          message: CLOCK,
        },
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'No I/O in a pure package — the caller does it and hands in the result.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'A pure package runs in Node and the browser alike — no DOM.' },
        {
          name: 'document',
          message: 'A pure package runs in Node and the browser alike — no DOM.',
        },
        { name: 'localStorage', message: 'No storage in a pure package — it has no I/O.' },
        { name: 'process', message: 'No ambient config. What a pure package needs, it is handed.' },
      ],
    },
  },
);
