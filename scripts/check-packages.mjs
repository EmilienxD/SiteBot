#!/usr/bin/env node
// Packs every public package and checks what a consumer would get:
//
//  - publint --strict: `exports`, `files` and entry points resolve, and the
//    tarball contains what package.json points at.
//  - are-the-types-wrong: each entry point resolves to types under Node16 and
//    bundler resolution. `cli` and `widget` are ESM-only by design, so they
//    are checked with the esm-only profile; node10 has no `exports` support
//    and is out of scope for everything.
//
// Run after `pnpm build`. Exits non-zero on the first package with problems.

import { spawnSync } from 'node:child_process'

const PACKAGES = {
  config: 'node16',
  core: 'node16',
  server: 'node16',
  ingest: 'node16',
  react: 'node16',
  cli: 'esm-only',
  widget: 'esm-only',
}

let failed = false
for (const [name, profile] of Object.entries(PACKAGES)) {
  const cwd = new URL(`../packages/${name}/`, import.meta.url)
  for (const [tool, args] of [
    ['publint', ['--strict']],
    ['attw', ['--pack', '.', '--profile', profile, '--format', 'ascii']],
  ]) {
    const result = spawnSync('npx', [tool, ...args], { cwd, encoding: 'utf8', shell: true })
    const ok = result.status === 0
    process.stdout.write(`${ok ? '✓' : '✗'} @sitebot/${name} — ${tool}\n`)
    if (!ok) {
      failed = true
      process.stdout.write(`${result.stdout}${result.stderr}\n`)
    }
  }
}
process.exit(failed ? 1 : 0)
