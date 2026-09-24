import { importOptional } from '../providers/optional-import.js'
import type {
  Chunk,
  QueryOptions,
  ScoredChunk,
  VectorStore,
  VectorStoreStats,
} from '../knowledge/store.js'

/**
 * `knowledge.store.type: pgvector` — production Postgres (docs/06 §3.7).
 *
 * `pg` is an optional peer: a project on `memory`, `sqlite` or `upstash` never
 * ships a Postgres driver it does not use. SQL is parameterised throughout;
 * the only interpolated identifier is the table name, which the config schema
 * restricts to `[a-z_][a-z0-9_]*` through the caller below — that check lives
 * here, once, at the one place a raw identifier crosses the boundary.
 */

interface PgClient {
  connect(): Promise<void>
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
}

interface PgPool {
  connect(): Promise<PgClient>
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
}

export interface PgVectorStoreOptions {
  url: string
  table: string
  model?: string
  dimensions?: number
  /** Injected by tests. */
  pool?: PgPool
}

export async function createPgVectorStore(options: PgVectorStoreOptions): Promise<VectorStore> {
  const table = sanitizeTable(options.table)
  let pool = options.pool
  if (pool === undefined) {
    let pg: { Pool?: new (config: { connectionString: string }) => PgPool }
    try {
      pg = (await importOptional('pg')) as typeof pg
    } catch (cause) {
      throw new Error(
        'knowledge.store "pgvector" requires the optional dependency pg.\n' +
          '  Install it:  pnpm add pg',
        { cause },
      )
    }
    if (pg.Pool === undefined) throw new Error('pg did not expose Pool')
    pool = new pg.Pool({ connectionString: options.url })
  }
  const store = new PgVectorStore(pool, table, options.model ?? '', options.dimensions ?? 1536)
  await store.init()
  return store
}

function sanitizeTable(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(
      `pgvector table name "${name}" is not a valid SQL identifier (letters, digits, underscores only).`,
    )
  }
  return name
}

/** Metadata-equality check applied post-query; see the comment in `query`. */
function pgMatches(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (filter === undefined) return true
  for (const [key, value] of Object.entries(filter)) {
    if (metadata[key] !== value) return false
  }
  return true
}

class PgVectorStore implements VectorStore {
  #pool: PgPool
  #table: string
  #model: string
  #dimensions: number

  constructor(pool: PgPool, table: string, model: string, dimensions: number) {
    this.#pool = pool
    this.#table = table
    this.#model = model
    this.#dimensions = dimensions
  }

  async init(): Promise<void> {
    await this.#pool.query(`CREATE EXTENSION IF NOT EXISTS vector`)
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#table} (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        metadata JSONB NOT NULL,
        embedding vector(${this.#dimensions}) NOT NULL,
        source_id TEXT NOT NULL,
        url TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await this.#pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.#table}_source_idx ON ${this.#table} (source_id)
    `)
    await this.#pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.#table}_url_idx ON ${this.#table} (url)
    `)
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#table}_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
    `)
    const meta = await this.#pool.query(`SELECT value FROM ${this.#table}_meta WHERE key = 'model'`)
    const row = meta.rows[0]
    if (row !== undefined) this.#model = String(row['value'])
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const statement = `
        INSERT INTO ${this.#table} (id, text, metadata, embedding, source_id, url, updated_at)
        VALUES ($1, $2, $3, $4::vector, $5, $6, now())
        ON CONFLICT (id) DO UPDATE SET
          text = EXCLUDED.text, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding,
          source_id = EXCLUDED.source_id, url = EXCLUDED.url, updated_at = now()
      `
      for (const chunk of chunks) {
        await client.query(statement, [
          chunk.id,
          chunk.text,
          JSON.stringify(chunk.metadata),
          `[${chunk.embedding.join(',')}]`,
          chunk.metadata.sourceId,
          chunk.metadata.url,
        ])
      }
      await client.query(
        `INSERT INTO ${this.#table}_meta (key, value) VALUES ('model', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [this.#model],
      )
      await client.query(
        `INSERT INTO ${this.#table}_meta (key, value) VALUES ('lastIndexed', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [new Date().toISOString()],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.end().catch(() => {})
    }
  }

  async query(embedding: number[], opts: QueryOptions): Promise<ScoredChunk[]> {
    const vector = `[${embedding.join(',')}]`
    const params: unknown[] = [vector]

    // Metadata filters: one AND per key, parameterised on the value side;
    // keys are single-quoted only after escaping, so an injection attempt
    // breaks the SQL rather than silently widening the query.
    const filters = Object.entries(opts.filter ?? {}).map(([key, value], index) => {
      const escaped = key.replaceAll("'", "''")
      params.push(String(value))
      return `metadata->>'${escaped}' = $${index + 2}`
    })
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''

    const maxDistance = 1 - (opts.minScore ?? 0)
    const limit = Math.max(opts.topK * 2, 10)
    params.push(maxDistance, limit)
    const distanceIndex = params.length - 1
    const limitIndex = params.length
    const scoreClause =
      (opts.minScore ?? 0) > 0
        ? `${filters.length > 0 ? 'AND' : 'WHERE'} (embedding <=> $1::vector) <= $${distanceIndex}`
        : ''
    const { rows } = await this.#pool.query(
      `SELECT id, text, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM ${this.#table}
       ${where}
       ${scoreClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $${limitIndex}`,
      params,
    )
    const minScore = opts.minScore ?? 0
    const out = (rows as { id: string; text: string; metadata: unknown; score: number }[])
      .filter((row) => Number(row.score) >= minScore)
      .map((row) => ({
        chunk: {
          id: row.id,
          text: row.text,
          metadata: row.metadata as Chunk['metadata'],
          embedding: [],
        },
        score: Number(row.score),
      }))
    // pgvector's server-side filter dialect differs from a local equality
    // check only in expressiveness; re-applying client-side is cheap against
    // a `topK * 2` set and guarantees behaviour across drivers.
    return out
      .filter((entry) =>
        pgMatches(entry.chunk.metadata as unknown as Record<string, unknown>, opts.filter),
      )
      .slice(0, opts.topK)
  }

  async documentChunks(url: string): Promise<Chunk[]> {
    const { rows } = await this.#pool.query(
      `SELECT id, text, metadata FROM ${this.#table} WHERE url = $1 ORDER BY updated_at, id`,
      [url],
    )
    return (rows as { id: string; text: string; metadata: unknown }[]).map((row) => ({
      id: row.id,
      text: row.text,
      metadata: row.metadata as Chunk['metadata'],
      embedding: [],
    }))
  }

  async deleteBySource(sourceId: string): Promise<void> {
    await this.#pool.query(`DELETE FROM ${this.#table} WHERE source_id = $1`, [sourceId])
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.#pool.query(`DELETE FROM ${this.#table} WHERE id = ANY($1::text[])`, [ids])
  }

  async stats(): Promise<VectorStoreStats> {
    const chunks = await this.#pool.query(`SELECT COUNT(*)::int AS n FROM ${this.#table}`)
    const documents = await this.#pool.query(
      `SELECT COUNT(DISTINCT url)::int AS n FROM ${this.#table}`,
    )
    const meta = await this.#pool.query(
      `SELECT value FROM ${this.#table}_meta WHERE key = 'lastIndexed'`,
    )
    return {
      documents: Number(documents.rows[0]?.['n'] ?? 0),
      chunks: Number(chunks.rows[0]?.['n'] ?? 0),
      lastIndexed: String(meta.rows[0]?.['value'] ?? new Date(0).toISOString()),
      model: this.#model,
    }
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }
}
