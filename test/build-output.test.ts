import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * tsup rewrites `node:x` to `x` unless told not to. For most built-ins that is
 * harmless, but some exist *only* under the prefix — `node:sqlite` has no bare
 * `sqlite` — and the rewrite silently broke `storage.type: sqlite` and the
 * sqlite vector store in every built package while the source-level tests
 * stayed green. Both the config and the shipped output are checked.
 */

const ROOT = join(import.meta.dirname, '..')
const NODE_PACKAGES = ['config', 'core', 'server', 'ingest', 'cli']
const PREFIX_ONLY = ['sqlite', 'test', 'sea', 'test/reporters']

describe('Node packages keep the node: protocol', () => {
  it.each(NODE_PACKAGES)('%s/tsup.config.ts sets removeNodeProtocol: false', (name) => {
    const config = readFileSync(join(ROOT, 'packages', name, 'tsup.config.ts'), 'utf8')
    expect(config).toMatch(/removeNodeProtocol:\s*false/)
  })

  it.each(NODE_PACKAGES)('%s/dist imports no prefix-only built-in without its prefix', (name) => {
    const dist = join(ROOT, 'packages', name, 'dist')
    if (!existsSync(dist)) return // not built yet; CI builds before testing
    const files = readdirSync(dist, { recursive: true, encoding: 'utf8' }).filter((file) =>
      /\.(c|m)?js$/.test(file),
    )
    for (const file of files) {
      const source = readFileSync(join(dist, file), 'utf8')
      for (const builtin of PREFIX_ONLY) {
        const bare = new RegExp(`(from|import\\(|require\\()\\s*["']${builtin}["']`)
        expect(source, `${name}/dist/${file} imports "${builtin}" without node:`).not.toMatch(bare)
      }
    }
  })
})
