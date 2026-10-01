import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import { createNodeVectorStore } from '@sitebot/core/node'
import { runIngest } from './pipeline.js'
import { createQueryEmbedder } from './query-embedder.js'

/**
 * Real-embedding ingestion — `pnpm test:live` only (docs/04 §10).
 *
 * The offline suites inject a lexical embedder. These call a real embedding
 * model and write to a real store, then retrieve with a paraphrase that
 * shares no keywords with the source — which only a real embedding can match.
 *
 *   OPENAI_API_KEY                   text-embedding-3-small
 *   SITEBOT_LIVE_OLLAMA_EMBED_MODEL  a local embedding model, e.g. nomic-embed-text
 *   SITEBOT_LIVE_PG_URL              adds pgvector to the stores exercised (sqlite always runs)
 */

const env = process.env

const EMBEDDERS = [
  {
    name: 'openai',
    enabled: env['OPENAI_API_KEY'] !== undefined,
    embedding: { provider: 'openai', model: 'text-embedding-3-small' },
  },
  {
    name: 'ollama',
    enabled: env['SITEBOT_LIVE_OLLAMA_EMBED_MODEL'] !== undefined,
    embedding: { provider: 'ollama', model: env['SITEBOT_LIVE_OLLAMA_EMBED_MODEL'] ?? 'unset' },
  },
]

type StoreConfig =
  { type: 'sqlite'; path: string } | { type: 'pgvector'; url: string; table: string }

const STORES = [
  {
    name: 'sqlite',
    enabled: true,
    store: (dir: string): StoreConfig => ({ type: 'sqlite', path: join(dir, 'index.db') }),
  },
  {
    name: 'pgvector',
    enabled: env['SITEBOT_LIVE_PG_URL'] !== undefined,
    store: (): StoreConfig => ({
      type: 'pgvector',
      url: env['SITEBOT_LIVE_PG_URL'] ?? '',
      table: `sitebot_live_ingest_${randomUUID().slice(0, 8)}`,
    }),
  },
]

const SOURCES = [
  {
    type: 'text',
    id: 'shipping',
    content:
      'Every bag ships within 48 hours of roasting. Delivery inside the United States takes two to four business days. We do not ship internationally yet.',
  },
  {
    type: 'text',
    id: 'returns',
    content:
      'If a bag is unopened you may return it within 30 days for a full refund. Opened bags can be exchanged once for a different roast.',
  },
  {
    type: 'text',
    id: 'brewing',
    content:
      'For pour-over use 15 grams of medium-fine grounds to 250 grams of water at 94 degrees Celsius, poured in three stages over three minutes.',
  },
]

for (const embedder of EMBEDDERS) {
  for (const target of STORES) {
    describe.skipIf(!embedder.enabled || !target.enabled)(
      `live ingest: ${embedder.name} embeddings → ${target.name}`,
      () => {
        it('indexes, retrieves by meaning, and skips unchanged content on rerun', async () => {
          const directory = await mkdtemp(join(tmpdir(), 'sitebot-live-ingest-'))
          const storeConfig = target.store(directory)
          try {
            const result = validateConfig(
              {
                version: 1,
                name: 'Live ingest',
                backend: { provider: 'anthropic', model: 'unused', apiKey: 'unused' },
                prompt: { system: 'Test' },
                knowledge: {
                  sources: SOURCES,
                  embedding: embedder.embedding,
                  chunk: { strategy: 'heading' },
                  store: storeConfig,
                },
              },
              { env: {}, baseDir: directory },
            )
            if (!result.ok) throw new Error(JSON.stringify(result.errors))
            const config = result.value

            const first = await runIngest(config, { manifestDir: directory })
            expect(first.index.chunks).toBeGreaterThanOrEqual(SOURCES.length)
            expect(first.embedding.chunks).toBe(first.index.chunks)

            const rerun = await runIngest(config, { manifestDir: directory })
            expect(rerun.chunksAffected).toBe(0)
            expect(rerun.embedding.chunks).toBe(0)

            const embed = await createQueryEmbedder(config.knowledge.embedding!)
            const store = await createNodeVectorStore(config.knowledge.store, {
              baseDir: directory,
            })
            try {
              // Paraphrases with no keyword overlap with the matching source.
              const cases = [
                ['How soon will my parcel get to me?', 'shipping'],
                ['Can I get my money back for a coffee I never opened?', 'returns'],
                ['What ratio should I use for a V60?', 'brewing'],
              ] as const
              for (const [question, expected] of cases) {
                const { embedding } = await embed.embed(question)
                const [top] = await store.query(embedding, { topK: 1 })
                expect(top?.chunk.metadata.sourceId, question).toBe(expected)
              }
              expect((await store.stats()).model).toBe(embedder.embedding.model)
            } finally {
              await store.close()
            }
            if (storeConfig.type === 'pgvector') {
              const pool = new pg.Pool({ connectionString: storeConfig.url })
              await pool.query(
                `DROP TABLE IF EXISTS ${storeConfig.table}, ${storeConfig.table}_meta`,
              )
              await pool.end()
            }
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        }, 120_000)
      },
    )
  }
}
