import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import { createNodeVectorStore } from '@sitebot/core/node'
import { runIngest } from './pipeline.js'
import { createQueryEmbedder } from './query-embedder.js'
import { readManifest } from './manifest.js'

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

async function removeSyntheticDirectory(directory: string): Promise<void> {
  const target = resolve(directory)
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith('sitebot-pg-fixture-')
  ) {
    throw new Error('Unsafe fixture cleanup target')
  }
  await rm(target, { recursive: true, force: true })
}

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

describe.skipIf(env['SITEBOT_LIVE_PG_URL'] === undefined)(
  'live pgvector ingestion with synthetic vectors (no model quality claim)',
  () => {
    it('persists language/citation metadata, skips unchanged inputs and enforces model/dimension/prefix rebuilds', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'sitebot-pg-fixture-'))
      const table = `sitebot_fixture_${randomUUID().replaceAll('-', '')}`
      const url = env['SITEBOT_LIVE_PG_URL']!
      const admin = new pg.Pool({ connectionString: url })
      const calls: string[][] = []
      let width = 3
      const embedder = {
        embedBatch: async (texts: string[]) => {
          calls.push(texts)
          return {
            embeddings: texts.map(() => Array.from({ length: width }, (_, i) => (i === 0 ? 1 : 0))),
            tokens: texts.length,
          }
        },
      }
      const result = validateConfig(
        {
          version: 1,
          name: 'Synthetic ingestion',
          backend: { provider: 'ollama', model: 'unused' },
          prompt: { system: 'fixture' },
          knowledge: {
            sources: [
              {
                type: 'text',
                id: 'english',
                lang: 'en',
                content: 'The synthetic trial lasts seven days.',
              },
              {
                type: 'text',
                id: 'french',
                lang: 'fr-CA',
                content: 'La période d’essai synthétique dure sept jours.',
              },
            ],
            store: { type: 'pgvector', url, table },
            embedding: {
              provider: 'ollama',
              model: 'fixture-a',
              dimensions: 3,
              documentPrefix: 'document: ',
            },
            chunk: { minTokens: 0 },
          },
        },
        { env: {}, baseDir: directory },
      )
      if (!result.ok) throw new Error('Invalid synthetic ingestion fixture')
      const config = result.value
      let observer: Awaited<ReturnType<typeof createNodeVectorStore>> | undefined
      const options = { embedder, manifestDir: directory }
      const inspect = async () => {
        const store = await createNodeVectorStore(config.knowledge.store)
        try {
          const french = (await store.documentChunks!('sitebot:french'))[0]!
          expect(french.metadata).toMatchObject({
            lang: 'fr-CA',
            language: 'fr',
            sourceId: 'french',
            url: 'sitebot:french',
            ordinal: 0,
          })
          expect(french.text).not.toMatch(/^document:/)
          return await store.stats()
        } finally {
          await store.close()
        }
      }
      try {
        expect((await runIngest(config, options)).index.chunks).toBe(2)
        expect(calls.flat().every((text) => text.startsWith('document: '))).toBe(true)
        expect((await inspect()).model).toBe('fixture-a')
        observer = await createNodeVectorStore(config.knowledge.store)
        expect((await observer.stats()).model).toBe('fixture-a')
        expect((await runIngest(config, options)).embedding.chunks).toBe(0)
        expect(calls).toHaveLength(1)
        for (const change of [
          { documentPrefix: 'new-document: ' },
          { model: 'fixture-b' },
          { dimensions: 4 },
        ]) {
          const original = { ...config.knowledge.embedding! }
          Object.assign(config.knowledge.embedding!, change)
          await expect(runIngest(config, options)).rejects.toThrow('ingest --force')
          await expect(
            runIngest(config, { ...options, force: true, sourceIds: ['english'] }),
          ).rejects.toThrow('rebuilding every source')
          config.knowledge.embedding = original
        }
        config.knowledge.embedding = {
          ...config.knowledge.embedding!,
          model: 'fixture-b',
          dimensions: 4,
          documentPrefix: 'new-document: ',
        }
        width = 4
        await runIngest(config, { ...options, force: true })
        expect((await inspect()).model).toBe('fixture-b')
        expect((await observer.stats()).model).toBe('fixture-b')
        expect(await readManifest({ dir: directory })).toMatchObject({
          model: 'fixture-b',
          dimensions: 4,
          documentPrefix: 'new-document: ',
        })
        // A failed embedding run must release the automatically opened pool.
        await expect(
          runIngest(config, {
            ...options,
            force: true,
            embedder: {
              embedBatch: async () => {
                throw new Error('synthetic embedding failure')
              },
            },
          }),
        ).rejects.toThrow('synthetic embedding failure')
        expect((await inspect()).chunks).toBe(2)
      } finally {
        await observer?.close()
        await admin.query(`DROP TABLE IF EXISTS ${table}, ${table}_meta`)
        await admin.end()
        await removeSyntheticDirectory(directory)
      }
    })
  },
)

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
