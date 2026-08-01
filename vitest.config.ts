import { defineConfig } from 'vitest/config'

/**
 * Vitest 4 replaced `vitest.workspace.ts` with `test.projects` here.
 * One project per package so a failure names the package it came from.
 */

const nodeProject = (name: string) => ({
  test: {
    name,
    root: `./packages/${name}`,
    environment: 'node' as const,
    include: ['src/**/*.test.ts'],
  },
})

export default defineConfig({
  test: {
    projects: [
      nodeProject('config'),
      nodeProject('core'),
      nodeProject('server'),
      nodeProject('ingest'),
      nodeProject('cli'),
      {
        test: {
          name: 'widget',
          root: './packages/widget',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'react',
          root: './packages/react',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
      {
        // Repo-level tests: the dependency graph of docs/01 §3, enforced.
        test: {
          name: 'boundaries',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Opt-in only: real provider calls. Never part of `pnpm test`.
        // docs/04-providers-and-engine.md §10 — no CI test may hit a provider.
        test: {
          name: 'live',
          include: ['packages/**/src/**/*.live.test.ts'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/dist/**', '**/*.config.ts', '**/*.test.ts'],
    },
  },
})
