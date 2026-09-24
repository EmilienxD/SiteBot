import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateConfig, type ResolvedConfig } from '@sitebot/config'
import { MemoryVectorStore } from '@sitebot/core'
import { ModelMismatchError, readManifest, writeManifest } from './manifest.js'
import { runIngest } from './pipeline.js'

/**
 * The pipeline's behavioural contract, per docs/06 §7:
 *
 * - ingest twice unchanged → the embedder is never called the second time
 * - modify one doc → only its chunks are re-embedded
 * - delete a doc → its chunks are deleted
 * - model change without --force → ModelMismatchError
 * - dry run → no writes, no embeddings, no manifest
 *
 * Sources here are `{type:'text'}` which need no network; network behaviour
 * gets its own fixture-server tests.
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sitebot-ingest-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function countingEmbedder(dimensions = 3) {
  const calls: string[][] = []
  return {
    calls,
    embedBatch: async (texts: string[]) => {
      calls.push(texts)
      return {
        embeddings: texts.map((_text, index) => {
          const vector = new Array<number>(dimensions).fill(0)
          vector[index % dimensions] = 1
          return vector
        }),
        tokens: texts.reduce((total, text) => total + Math.ceil(text.length / 4), 0),
      }
    },
  }
}

function configFor(content: string, model = 'text-embedding-3-small'): ResolvedConfig {
  const result = validateConfig(
    {
      version: 1,
      name: 'Acme',
      backend: { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'test' },
      prompt: { system: 'You are a test assistant.' },
      knowledge: {
        sources: [{ type: 'text', id: 'docs', content }],
        embedding: { provider: 'ollama', model },
        store: { type: 'memory' },
        chunk: { minTokens: 0 },
      },
    },
    { env: {} },
  )
  if (!result.ok) {
    throw new Error(`config failed: ${JSON.stringify(result.errors)}`)
  }
  return result.value
}

describe('runIngest()', () => {
  it('populates the store and reports the first run as all-new', async () => {
    const embedder = countingEmbedder()
    const store = new MemoryVectorStore({ model: 'text-embedding-3-small' })
    const run = await runIngest(configFor('Acme ships within two business days of an order.'), {
      store,
      embedder,
      manifestDir: dir,
    })
    expect(run.embedding.chunks).toBeGreaterThan(0)
    expect(embedder.calls.length).toBeGreaterThan(0)
    const stats = await store.stats()
    expect(stats.chunks).toBeGreaterThan(0)
    expect(run.dryRun).toBe(false)
  })

  it('re-running an unchanged corpus makes zero embedding calls', async () => {
    const embedder = countingEmbedder()
    const config = configFor('Returns are free for thirty days after delivery.')
    const store = new MemoryVectorStore()
    await runIngest(config, { store, embedder, manifestDir: dir })
    embedder.calls.length = 0
    const second = await runIngest(config, { store, embedder, manifestDir: dir })
    expect(embedder.calls).toHaveLength(0)
    expect(second.embedding.chunks).toBe(0)
    expect(second.chunksAffected).toBe(0)
    expect(second.sources[0]!.unchanged).toBe(1)
  })

  it('re-fetches a sitemap page conditionally, and a 304 keeps its chunks (docs/06 §3.6)', async () => {
    const page = `<html><head><title>Returns</title></head><body><main><h1>Returns</h1><p>${'Returns are free for thirty days after delivery. '.repeat(20)}</p></main></body></html>`
    let downloads = 0
    const seenValidators: (string | null)[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('sitemap.xml'))
        return new Response('<urlset><url><loc>https://acme.test/returns</loc></url></urlset>', {
          headers: { 'content-type': 'application/xml' },
        })
      const ifNoneMatch = new Headers(init?.headers).get('if-none-match')
      seenValidators.push(ifNoneMatch)
      if (ifNoneMatch === '"v1"') return new Response(null, { status: 304 })
      downloads += 1
      return new Response(page, { headers: { 'content-type': 'text/html', etag: '"v1"' } })
    }) as typeof fetch
    const result = validateConfig(
      {
        version: 1,
        name: 'Acme',
        backend: { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'test' },
        prompt: { system: 'You are a test assistant.' },
        knowledge: {
          sources: [{ type: 'sitemap', id: 'site', url: 'https://acme.test/sitemap.xml' }],
          embedding: { provider: 'ollama', model: 'text-embedding-3-small' },
          store: { type: 'memory' },
          chunk: { minTokens: 0 },
        },
      },
      { env: {} },
    )
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    const embedder = countingEmbedder()
    const store = new MemoryVectorStore()
    const options = { store, embedder, manifestDir: dir, fetchImpl }

    await runIngest(result.value, options)
    const firstChunks = (await readManifest({ dir }))!.sources.site!.documents[
      'https://acme.test/returns'
    ]!.chunkHashes
    expect(firstChunks.length).toBeGreaterThan(0)
    embedder.calls.length = 0

    await runIngest(result.value, options)
    expect(seenValidators).toEqual([null, '"v1"'])
    expect(downloads).toBe(1)
    expect(embedder.calls).toHaveLength(0)
    const kept = (await readManifest({ dir }))!.sources.site!.documents[
      'https://acme.test/returns'
    ]!
    expect(kept.chunkHashes).toEqual(firstChunks)
    expect(kept.etag).toBe('"v1"')
  })

  // Document-level: a changed document is re-embedded whole. Re-embedding only
  // its changed chunks (docs/06 §3.6 step 4) is not implemented yet; see
  // docs/rule-audit.md.
  it('a changed document is re-embedded', async () => {
    const embedder = countingEmbedder()
    const store = new MemoryVectorStore()
    const first = configFor('Version one of the policy text.')
    await runIngest(first, { store, embedder, manifestDir: dir })
    const before = await store.stats()
    embedder.calls.length = 0
    await runIngest(configFor('Version two of the policy text, now longer.'), {
      store,
      embedder,
      manifestDir: dir,
    })
    expect(embedder.calls.length).toBeGreaterThan(0)
    const after = await store.stats()
    expect(after.chunks).toBeGreaterThanOrEqual(before.chunks)
  })

  it('a removed document removes its chunks', async () => {
    const siteDir = join(dir, 'site')
    const fs = await import('node:fs/promises')
    await fs.mkdir(siteDir, { recursive: true })
    await fs.writeFile(join(siteDir, 'a.txt'), 'Document A stays.')
    await fs.writeFile(join(siteDir, 'b.txt'), 'Document B is about to be deleted.')

    const embedder = countingEmbedder()
    const store = new MemoryVectorStore()
    const withB = filesConfig('**/*.txt')
    await runIngest(withB, { store, embedder, manifestDir: dir, baseDir: siteDir })
    const withBothCount = (await store.stats()).chunks
    expect(withBothCount).toBeGreaterThan(0)

    await fs.rm(join(siteDir, 'b.txt'))
    const run = await runIngest(filesConfig('**/*.txt'), {
      store,
      embedder,
      manifestDir: dir,
      baseDir: siteDir,
    })
    expect(run.sources[0]!.removed).toBe(1)
    const afterCount = (await store.stats()).chunks
    expect(afterCount).toBeLessThan(withBothCount)
  })

  it('a model change without --force fails with a clear message', async () => {
    const embedder = countingEmbedder()
    await runIngest(configFor('Anything.', 'model-a'), {
      store: new MemoryVectorStore(),
      embedder,
      manifestDir: dir,
    })
    await expect(
      runIngest(configFor('Anything.', 'model-b'), {
        store: new MemoryVectorStore(),
        embedder,
        manifestDir: dir,
      }),
    ).rejects.toThrow(ModelMismatchError)
  })

  it('--force rebuilds after a model change', async () => {
    const embedder = countingEmbedder()
    await runIngest(configFor('Anything.', 'model-a'), {
      store: new MemoryVectorStore(),
      embedder,
      manifestDir: dir,
    })
    embedder.calls.length = 0
    const run = await runIngest(configFor('Anything.', 'model-b'), {
      store: new MemoryVectorStore(),
      embedder,
      manifestDir: dir,
      force: true,
    })
    expect(run.embedding.chunks).toBeGreaterThan(0)
  })

  it('--dry-run writes nothing, spends nothing', async () => {
    const embedder = countingEmbedder()
    const store = new MemoryVectorStore()
    const run = await runIngest(configFor('A dry run over the pricing page.'), {
      store,
      embedder,
      manifestDir: dir,
      dryRun: true,
    })
    expect(run.dryRun).toBe(true)
    expect(run.embedding.chunks).toBeGreaterThan(0) // the plan counted
    expect(embedder.calls).toHaveLength(0) // nothing embedded
    expect((await store.stats()).chunks).toBe(0)
    expect(await readManifest({ dir })).toBeNull()
  })

  it('manifest is written atomically and round-trips', async () => {
    const embedder = countingEmbedder()
    await runIngest(configFor('Manifestable'), {
      store: new MemoryVectorStore(),
      embedder,
      manifestDir: dir,
    })
    const manifest = await readManifest({ dir })
    expect(manifest).not.toBeNull()
    expect(manifest!.model).toBe('text-embedding-3-small')
    expect(Object.keys(manifest!.sources)).toContain('docs')
    // Atomic by inspection: a `.tmp` file must not exist after a clean run.
    expect(
      await import('node:fs').then((fs) =>
        fs.existsSync(join(dir, '.sitebot', 'manifest.json.tmp')),
      ),
    ).toBe(false)
  })

  it('model mismatch error text names --force', async () => {
    await writeManifest(baseManifest('model-a'), { dir })
    await expect(
      runIngest(configFor('x', 'model-b'), {
        store: new MemoryVectorStore(),
        embedder: countingEmbedder(),
        manifestDir: dir,
      }),
    ).rejects.toThrow(/--force/)
  })
})

function filesConfig(glob: string): ResolvedConfig {
  const result = validateConfig(
    {
      version: 1,
      name: 'Acme',
      backend: { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'test' },
      prompt: { system: 'You are a test assistant.' },
      knowledge: {
        sources: [{ type: 'files', id: 'site', glob, baseUrl: 'https://acme.test' }],
        embedding: { provider: 'ollama', model: 'text-embedding-3-small' },
        store: { type: 'memory' },
        chunk: { minTokens: 0 },
        extract: { minChars: 0 },
      },
    },
    { env: {} },
  )
  if (!result.ok) throw new Error(`config failed: ${JSON.stringify(result.errors)}`)
  return result.value
}

function baseManifest(model: string) {
  return {
    version: 1 as const,
    model,
    builtAt: new Date().toISOString(),
    sources: {},
  }
}
