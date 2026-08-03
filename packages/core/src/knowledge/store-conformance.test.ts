import { MemoryVectorStore } from './memory-store.js'
import { createSqliteVectorStore } from '../node/vector-sqlite.js'
import { createPgVectorStore } from '../node/vector-pgvector.js'
import { createUpstashVectorStore } from '../node/vector-upstash.js'
import { runVectorStoreConformance } from '../../test/vector-store-conformance.js'

/**
 * docs/06 §7: one conformance suite, every implementation this repo ships.
 *
 * pgvector, upstash and custom need live infrastructure or third-party code;
 * their suites *run* whenever a developer points the env vars at a real
 * endpoint (see the gated `live` project in `vitest.config.ts`) and are
 * reported as skipped here, which is the honest state of a CI box.
 */

runVectorStoreConformance({
  name: 'memory',
  create: async (model) =>
    new MemoryVectorStore({ ...(model === undefined ? {} : { model }) }),
})

/** An in-memory SQL stand-in exercising the sqlite store's real code path. */
function fakeSqlite(): { openDatabase: () => object } {
  const rows = new Map<string, Record<string, unknown>>()
  const meta = new Map<string, string>()
  const db = {
    exec: () => {},
    prepare(sql: string) {
      return {
        run(...params: unknown[]) {
          if (sql.startsWith('INSERT INTO chunks')) {
            const [id, text, embedding, metadata, source_id, url, updated_at] = params
            rows.set(String(id), {
              id,
              text,
              embedding,
              metadata,
              source_id,
              url,
              updated_at,
            })
            return
          }
          if (sql.startsWith('INSERT INTO store_meta')) {
            meta.set(String(params[0]), String(params[1]))
            return
          }
          if (sql.startsWith('DELETE FROM chunks WHERE source_id')) {
            for (const [id, row] of rows) if (row['source_id'] === params[0]) rows.delete(id)
            return
          }
          if (sql.startsWith('DELETE FROM chunks WHERE id')) {
            rows.delete(String(params[0]))
            return
          }
        },
        get(): unknown {
          if (sql.includes("WHERE key = 'model'")) {
            const value = meta.get('model')
            return value === undefined ? undefined : { value }
          }
          if (sql.includes("WHERE key = 'lastIndexed'")) {
            const value = meta.get('lastIndexed')
            return value === undefined ? undefined : { value }
          }
          if (sql.startsWith('SELECT COUNT(*)')) return { n: rows.size }
          if (sql.startsWith('SELECT COUNT(DISTINCT url)')) {
            return { n: new Set([...rows.values()].map((row) => row['url'])).size }
          }
          return undefined
        },
        all(...params: unknown[]): unknown[] {
          if (sql.includes('FROM chunks WHERE url')) {
            return [...rows.values()].filter((row) => row['url'] === params[0])
          }
          if (sql.startsWith('SELECT * FROM chunks')) return [...rows.values()]
          return []
        },
      }
    },
    close: () => {},
  }
  return { openDatabase: () => db }
}

runVectorStoreConformance({
  name: 'sqlite',
  create: async (model) =>
    createSqliteVectorStore({
      path: ':memory:',
      ...(model === undefined ? {} : { model }),
      openDatabase: fakeSqlite().openDatabase as never,
    }),
})

/**
 * pgvector with an in-memory driver stand-in. The fake understands exactly
 * the SQL the store emits — that is the point of a conformance suite: a store
 * that changes its SQL without updating the fake fails here, not in prod.
 */
interface PgRows {
  chunks: Map<string, Record<string, unknown>>
  meta: Map<string, string>
}

function fakePg(rows: PgRows = { chunks: new Map(), meta: new Map() }) {
  function scoresOf(vector: number[]) {
    const scored = [...rows.chunks.values()].map((row) => {
      const stored = Array.isArray(row['embedding'])
        ? (row['embedding'] as number[])
        : (JSON.parse(String(row['embedding'])) as number[])
      let dot = 0
      let na = 0
      let nb = 0
      for (let index = 0; index < vector.length; index++) {
        dot += (vector[index] ?? 0) * (stored[index] ?? 0)
        na += (vector[index] ?? 0) ** 2
        nb += (stored[index] ?? 0) ** 2
      }
      return {
        id: row['id'],
        text: row['text'],
        metadata: row['metadata'],
        score: na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb)),
      }
    })
    scored.sort((a, b) => (b.score as number) - (a.score as number))
    return scored
  }
  const pool = {
    query: async (rawText: string, params: unknown[] = []) => {
      const text = rawText.trimStart()
      if (/^(CREATE|BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] }
      if (text.startsWith('SELECT value') && text.includes('_meta')) {
        const key = String(params[0]).replace(/^['"]|['"]$/g, '')
        const value = rows.meta.get(key)
        return { rows: value === undefined ? [] : [{ value }] }
      }
      if (text.startsWith('INSERT INTO') && text.includes('_meta')) {
        rows.meta.set(String(params[0]), String(params[1]))
        return { rows: [] }
      }
      if (text.startsWith('INSERT INTO')) {
        const [id, ctext, metadata, embedding] = params
        rows.chunks.set(String(id), {
          id,
          text: ctext,
          metadata: JSON.parse(String(metadata)) as unknown,
          source_id: (JSON.parse(String(metadata)) as { sourceId: string }).sourceId,
          url: (JSON.parse(String(metadata)) as { url: string }).url,
          embedding: String(embedding),
        })
        return { rows: [] }
      }
      if (text.startsWith('SELECT id, text, metadata, 1 - (embedding')) {
        const vector = JSON.parse(String(params[0])) as number[]
        const limit = Number(params.at(-1)) || 10
        return { rows: scoresOf(vector).slice(0, limit) as unknown as Record<string, unknown>[] }
      }
      if (text.startsWith('SELECT id, text, metadata FROM')) {
        return {
          rows: [...rows.chunks.values()].filter((row) => row['url'] === params[0]).map((row) => ({
            id: row['id'],
            text: row['text'],
            metadata: row['metadata'],
          })),
        }
      }
      if (text.startsWith('DELETE FROM') && text.includes('source_id')) {
        for (const [id, row] of rows.chunks) if (row['source_id'] === params[0]) rows.chunks.delete(id)
        return { rows: [] }
      }
      if (text.startsWith('DELETE FROM') && text.includes('id = ANY')) {
        for (const id of params[0] as string[]) rows.chunks.delete(String(id))
        return { rows: [] }
      }
      if (text.startsWith('SELECT COUNT(*)')) return { rows: [{ n: rows.chunks.size }] }
      if (text.startsWith('SELECT COUNT(DISTINCT url)')) {
        return { rows: [{ n: new Set([...rows.chunks.values()].map((row) => row['url'])).size }] }
      }
      return { rows: [] }
    },
    connect: async () => pool,
    end: async () => {},
  }
  return pool
}

runVectorStoreConformance({
  name: 'pgvector',
  create: async (model) =>
    createPgVectorStore({
      url: 'postgres://unused',
      table: 'sitebot_chunks',
      ...(model === undefined ? {} : { model }),
      pool: fakePg() as never,
    }),
})

/** Upstash with the same application-side scoring the hosted API applies. */
function fakeUpstash() {
  const vectors = new Map<string, { vector: number[]; metadata: Record<string, unknown> }>()
  let model = ''
  return {
    upsert: async (
      items: { id: string; vector: number[]; metadata?: Record<string, unknown> }[],
    ) => {
      for (const item of items) {
        vectors.set(item.id, {
          vector: item.vector,
          metadata: (item.metadata ?? {}) as Record<string, unknown>,
        })
        model = String(item.metadata?.['embeddingModel'] ?? model)
      }
    },
    query: async (options: { vector: number[]; topK: number }) => {
      const scored = [...vectors.entries()].map(([id, entry]) => {
        const { vector } = entry
        let dot = 0
        let na = 0
        let nb = 0
        for (let index = 0; index < options.vector.length; index++) {
          dot += (options.vector[index] ?? 0) * (vector[index] ?? 0)
          na += (options.vector[index] ?? 0) ** 2
          nb += (vector[index] ?? 0) ** 2
        }
        return {
          id,
          score: na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb)),
          metadata: entry.metadata,
        }
      })
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, options.topK)
    },
    delete: async (target: string[] | { filter: string }) => {
      if (Array.isArray(target)) {
        for (const id of target) vectors.delete(id)
        return
      }
      const match = /sourceId = '([^']*)'/.exec(target.filter)
      if (match !== null) {
        for (const [id, entry] of vectors) {
          if (entry.metadata['sourceId'] === match[1]) vectors.delete(id)
        }
      }
    },
    info: async () => ({ vectorCount: vectors.size }),
    get model() {
      return model
    },
  }
}

runVectorStoreConformance({
  name: 'upstash',
  create: async (model) =>
    createUpstashVectorStore({
      url: 'https://unused.upstash.io',
      token: 'unused',
      ...(model === undefined ? {} : { model }),
      client: fakeUpstash() as never,
    }),
})
