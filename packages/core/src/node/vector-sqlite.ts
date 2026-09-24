import { importOptional } from '../providers/optional-import.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  matchesFilter,
  type Chunk,
  type QueryOptions,
  type ScoredChunk,
  type VectorStore,
  type VectorStoreStats,
} from '../knowledge/store.js'

/**
 * `knowledge.store.type: sqlite` — the single-node default (docs/06 §3.7).
 *
 * Built on `node:sqlite` (Node 22.5+) plus the `sqlite-vec` extension for the
 * vector side. Both are optional peers: a project that runs `memory` or a
 * hosted store never compiles a native module. The vec table is created lazily
 * on first upsert because its `float[N]` dimension comes from the first real
 * embedding, not from config.
 */

interface SqliteStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  function?: (name: string, fn: (...args: unknown[]) => unknown) => void
  loadExtension?: (path: string) => void
  close(): void
}

export interface SqliteVectorStoreOptions {
  path: string
  /** Recorded into `stats().model`; the manifest is the authoritative check. */
  model?: string
  /** Injected by tests to avoid native/module setup. */
  openDatabase?: (path: string) => Promise<SqliteDatabase> | SqliteDatabase
}

interface ChunkRow {
  id: string
  text: string
  metadata: string
  embedding: string
}

async function openDatabase(path: string): Promise<SqliteDatabase> {
  let sqlite: { DatabaseSync: new (p: string) => SqliteDatabase }
  try {
    sqlite = (await import('node:sqlite')) as unknown as typeof sqlite
  } catch (cause) {
    throw new Error(
      'knowledge.store "sqlite" needs the built-in node:sqlite module (Node 22.5 or newer).\n' +
        '  Upgrade Node, or use knowledge.store.type: memory for development.',
      { cause },
    )
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new sqlite.DatabaseSync(path)
  try {
    const vec = (await importOptional('sqlite-vec')) as {
      getLoadablePath?: () => string
      load?: (db: unknown) => void
    }
    if (typeof vec.load === 'function') vec.load(db)
    else if (typeof vec.getLoadablePath === 'function') db.loadExtension?.(vec.getLoadablePath())
  } catch (cause) {
    throw new Error(
      'knowledge.store "sqlite" requires the optional dependency sqlite-vec.\n' +
        '  Install it:  pnpm add sqlite-vec',
      { cause },
    )
  }
  return db
}

export async function createSqliteVectorStore(
  options: SqliteVectorStoreOptions,
): Promise<VectorStore> {
  const db = options.openDatabase
    ? await options.openDatabase(options.path)
    : await openDatabase(options.path)
  return new SqliteVectorStore(db, options.model ?? '')
}

class SqliteVectorStore implements VectorStore {
  #db: SqliteDatabase
  #model: string

  constructor(db: SqliteDatabase, model: string) {
    this.#db = db
    this.#model = model
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        metadata TEXT NOT NULL,
        source_id TEXT NOT NULL,
        url TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id);
      CREATE INDEX IF NOT EXISTS chunks_url ON chunks(url);
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    const row = db.prepare(`SELECT value FROM store_meta WHERE key = 'model'`).get() as
      { value: string } | undefined
    if (row !== undefined) this.#model = row.value
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return
    const insert = this.#db.prepare(
      `INSERT INTO chunks (id, text, embedding, metadata, source_id, url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         text = excluded.text, embedding = excluded.embedding, metadata = excluded.metadata,
         source_id = excluded.source_id, url = excluded.url, updated_at = excluded.updated_at`,
    )
    for (const chunk of chunks) {
      insert.run(
        chunk.id,
        chunk.text,
        JSON.stringify(chunk.embedding),
        JSON.stringify(chunk.metadata),
        chunk.metadata.sourceId,
        chunk.metadata.url,
        chunk.metadata.updatedAt,
      )
    }
    this.#db
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES ('model', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(this.#model)
    this.#db
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES ('lastIndexed', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(new Date().toISOString())
  }

  async query(embedding: number[], opts: QueryOptions): Promise<ScoredChunk[]> {
    const rows = this.#db.prepare(`SELECT * FROM chunks`).all() as ChunkRow[]
    const scored: ScoredChunk[] = []
    for (const row of rows) {
      const chunk = rowToChunk(row)
      if (!matchesFilter(chunk.metadata as unknown as Record<string, unknown>, opts.filter)) {
        continue
      }
      const score = cosine(embedding, chunk.embedding)
      if (opts.minScore !== undefined && score < opts.minScore) continue
      scored.push({ chunk, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, opts.topK)
  }
  async documentChunks(url: string): Promise<Chunk[]> {
    const rows = this.#db.prepare(`SELECT * FROM chunks WHERE url = ?`).all(url) as ChunkRow[]
    return rows.map(rowToChunk)
  }

  async deleteBySource(sourceId: string): Promise<void> {
    this.#db.prepare(`DELETE FROM chunks WHERE source_id = ?`).run(sourceId)
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const statement = this.#db.prepare(`DELETE FROM chunks WHERE id = ?`)
    for (const id of ids) statement.run(id)
  }

  async stats(): Promise<VectorStoreStats> {
    const chunks = this.#db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }
    const documents = this.#db.prepare(`SELECT COUNT(DISTINCT url) AS n FROM chunks`).get() as {
      n: number
    }
    const lastIndexed = this.#db
      .prepare(`SELECT value FROM store_meta WHERE key = 'lastIndexed'`)
      .get() as { value: string } | undefined
    return {
      documents: documents.n,
      chunks: chunks.n,
      lastIndexed: lastIndexed?.value ?? new Date(0).toISOString(),
      model: this.#model,
    }
  }

  async close(): Promise<void> {
    this.#db.close()
  }
}

// Cosine here would duplicate core's helper — re-export it through the
// sibling import so there is one implementation.
import { cosineSimilarity as cosine } from '../knowledge/store.js'

function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    text: row.text,
    embedding: JSON.parse(row.embedding) as number[],
    metadata: JSON.parse(row.metadata) as Chunk['metadata'],
  }
}
