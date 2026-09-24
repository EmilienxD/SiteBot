import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

/**
 * docs/00 topology T3: a Workers deployment bundles the fetch adapter, the
 * edge-safe config validator, the Upstash store and the query embedder. None
 * of that may reach a `node:*` module — Workers have no `node:sqlite` or
 * `node:dns`, and `nodejs_compat` is not a dependency we get to assume.
 *
 * Bundled for real, with the resolution conditions Wrangler uses, from the
 * built packages. `node:*` is marked external so the build succeeds and the
 * metafile shows exactly which ones would have been pulled in.
 */
const ENTRY = `
  export { validateConfig } from '@sitebot/config'
  export { createFetchHandler } from '@sitebot/server/fetch'
  export { createUpstashVectorStore, MemorySessionStore } from '@sitebot/core'
  export { createQueryEmbedder } from '@sitebot/ingest/query'
`

describe('edge bundle (Workers)', () => {
  it('reaches no node:* module and no Node-only entry', async () => {
    const result = await build({
      stdin: { contents: ENTRY, resolveDir: 'packages/server', loader: 'ts' },
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser', 'import'],
      mainFields: ['module', 'main'],
      external: ['node:*'],
      logLevel: 'silent',
    })
    const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
    const nodeOnly = imports.map((entry) => entry.path).filter((path) => path.startsWith('node:'))
    expect(nodeOnly, 'node:* imports reachable from the edge entry').toEqual([])
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.filter((path) => /core[/\\]dist[/\\]node\b/.test(path))).toEqual([])
  }, 60_000)
})
