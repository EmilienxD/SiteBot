import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

/**
 * Dependency boundaries — docs/01-architecture.md §3.
 *
 * The graph is strictly acyclic and layered. A package may only import from
 * packages below it:
 *
 *   layer 4  cli, apps
 *   layer 3  server (node)  |  widget, react (browser)
 *   layer 2  core
 *   layer 1  config
 */

const PKG = {
  config: '@sitebot/config',
  core: '@sitebot/core',
  server: '@sitebot/server',
  widget: '@sitebot/widget',
  react: '@sitebot/react',
  cli: '@sitebot/cli',
}

const ALL = Object.values(PKG)

/** Expand a package name into its bare + subpath import patterns. */
const spec = (name) => [name, `${name}/*`]

/**
 * @param {string[]} denied      package names this file may not import
 * @param {string}   why         the rule being enforced, quoted back to the developer
 * @param {string[]} typeOnly    package names importable with `import type` only
 */
function boundary(denied, why, typeOnly = []) {
  return {
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        patterns: [
          ...denied.map((name) => ({
            group: spec(name),
            message: `${why} (docs/01-architecture.md §3)`,
          })),
          ...typeOnly.map((name) => ({
            ...(name === PKG.config
              ? { regex: '^@sitebot/config(?:$|/(?!i18n(?:/(?:locale|launcher))?$))' }
              : { group: spec(name) }),
            message: `${why} — use \`import type\` (docs/01-architecture.md §3)`,
            allowTypeImports: true,
          })),
          {
            // Rule 7: only declared exports, never another package's internals.
            group: ['@sitebot/*/src/*', '@sitebot/*/dist/*'],
            message:
              'Import a package via its declared exports, never a deep internal path (docs/01-architecture.md §3 rule 7)',
          },
        ],
      },
    ],
  }
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/.wrangler/**',
      'apps/docs/.vitepress/cache/**',
      'examples/cloudflare-worker/public/widget/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'docs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // ── layer 1 ───────────────────────────────────────────────────────────────
  // Rule 1: config imports nothing from the workspace.
  {
    files: ['packages/config/src/**/*.ts'],
    rules: boundary(
      ALL.filter((p) => p !== PKG.config),
      '@sitebot/config is layer 1 and must not import from the workspace',
    ),
  },

  // Rule 6, applied to config as well: the root entry has to survive being
  // pulled into a browser bundle, so the loader lives under src/node/.
  {
    files: ['packages/config/src/**/*.ts'],
    ignores: ['packages/config/src/node/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto', 'child_process', 'worker_threads'],
              message:
                "@sitebot/config's main entry must stay browser-safe. Put Node-only code under src/node/ (docs/01-architecture.md §2)",
            },
          ],
        },
      ],
    },
  },

  // ── layer 2 ───────────────────────────────────────────────────────────────
  // Rule 2: core imports only config.
  {
    files: ['packages/core/src/**/*.ts'],
    rules: boundary(
      [PKG.server, PKG.widget, PKG.react, PKG.cli],
      '@sitebot/core may only import @sitebot/config',
    ),
  },
  // Rule 6: core's root entry must not import node:*. Node-only code lives in core/node.
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/node/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto', 'child_process', 'worker_threads'],
              message:
                "@sitebot/core's main entry must stay edge-compatible. Put Node-only code under src/node/ (docs/01-architecture.md §3 rule 6)",
            },
          ],
        },
      ],
    },
  },

  // ── layer 3, node ─────────────────────────────────────────────────────────
  // Rule 3: server imports core and config.
  {
    files: ['packages/server/src/**/*.ts'],
    rules: boundary(
      [PKG.widget, PKG.react, PKG.cli],
      '@sitebot/server may only import @sitebot/core and @sitebot/config',
    ),
  },

  // ── layer 3, browser ──────────────────────────────────────────────────────
  // Rule 4: widget and react import types only from config, and never core.
  {
    files: ['packages/widget/src/**/*.ts', 'packages/widget/src/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } },
    rules: boundary(
      [PKG.core, PKG.server, PKG.cli],
      '@sitebot/widget is a browser bundle and must not pull in server code',
      [PKG.config],
    ),
  },
  {
    files: ['packages/react/src/**/*.ts', 'packages/react/src/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } },
    rules: boundary(
      [PKG.core, PKG.server, PKG.cli],
      '@sitebot/react is a browser bundle and must not pull in server code',
      [PKG.config],
    ),
  },

  // ── layer 4 ───────────────────────────────────────────────────────────────
  // Rule 5 is the union of every rule above: no layer denies cli to itself, and
  // every other package denies it.
  {
    files: ['packages/cli/src/**/*.ts'],
    rules: {
      'no-console': 'off', // the CLI's job is to print
    },
  },

  // ── tests and tooling ─────────────────────────────────────────────────────
  {
    // Tests are never published, so the boundary rules that keep a bundle small
    // and edge-safe do not apply to them. A test that needs node:fs to build a
    // fixture project is doing exactly what it should.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: [
      '**/*.config.ts',
      '**/*.config.js',
      '**/scripts/**',
      'eslint.config.js',
      'vitest.config.ts',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-restricted-imports': 'off',
      'no-restricted-imports': 'off',
    },
  },
)
