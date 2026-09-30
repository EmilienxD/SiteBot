import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateConfig } from '@sitebot/config'
import { createNodeVectorStore } from '@sitebot/core/node'
import { runIngest } from './pipeline.js'

it('ingests incrementally into real SQLite and rebuilds with a new embedding model and dimensions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sitebot-ingest-sqlite-'))
  try {
    const result = validateConfig(
      {
        version: 1,
        name: 'SQLite test',
        backend: { provider: 'anthropic', model: 'unused', apiKey: 'offline-test' },
        prompt: { system: 'Test' },
        knowledge: {
          sources: [
            {
              type: 'text',
              id: 'guide',
              content: 'Documentation for our service and its shipping policy. '.repeat(20),
            },
          ],
          embedding: { provider: 'openai', model: 'offline-v1', dimensions: 3 },
          chunk: { strategy: 'fixed', maxTokens: 64, minTokens: 1, overlapTokens: 4 },
          store: { type: 'sqlite', path: join(directory, 'index.db') },
        },
      },
      { env: {}, baseDir: directory },
    )
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    const config = result.value
    let embeddings = 0
    const options = {
      manifestDir: directory,
      embedder: {
        embedBatch: async (texts: string[]) => {
          embeddings += texts.length
          return {
            embeddings: texts.map(() =>
              Array.from({ length: config.knowledge.embedding!.dimensions! }, (_, i) =>
                i === 0 ? 1 : 0,
              ),
            ),
            tokens: texts.length * 10,
          }
        },
      },
    }
    const first = await runIngest(config, options)
    expect(first.index.chunks).toBeGreaterThan(1)
    const originalCalls = embeddings
    const unchanged = await runIngest(config, options)
    expect(unchanged.chunksAffected).toBe(0)
    expect(embeddings).toBe(originalCalls)

    // An embedding failure must also release its database connection. The
    // final cleanup exercises this on Windows, where an open DB cannot unlink.
    const source = config.knowledge.sources[0]!
    if (source.type !== 'text') throw new Error('Expected text source')
    const originalContent = source.content
    source.content += ' Additional content to require embedding.'
    await expect(
      runIngest(config, {
        ...options,
        embedder: {
          embedBatch: async () => {
            throw new Error('embedding failed')
          },
        },
      }),
    ).rejects.toThrow('embedding failed')
    source.content = originalContent

    config.knowledge.embedding!.model = 'offline-v2'
    config.knowledge.embedding!.dimensions = 2
    await expect(runIngest(config, options)).rejects.toThrow(/force/i)
    const rebuilt = await runIngest(config, { ...options, force: true })
    expect(rebuilt.index.chunks).toBe(first.index.chunks)
    const store = await createNodeVectorStore(config.knowledge.store)
    try {
      expect((await store.stats()).model).toBe('offline-v2')
      const hits = await store.query([1, 0], { topK: 1 })
      expect(hits[0]!.chunk.text).toContain('Documentation')
      expect(hits[0]!.score).toBeCloseTo(1)
    } finally {
      await store.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
