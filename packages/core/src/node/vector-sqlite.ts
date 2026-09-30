import { importOptional, isModuleNotFound } from '../providers/optional-import.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type * as NodeSqlite from 'node:sqlite'
import type {
  Chunk,
  QueryOptions,
  ScoredChunk,
  VectorStore,
  VectorStoreStats,
} from '../knowledge/store.js'

/**
 * Node's extension API needs 22.13+, and sqlite-vec ships prebuilt binaries.
 * Chunk bodies stay in an ordinary table; vec0 owns float32 cosine search.
 * Both tables are written in one transaction. Existing JSON-only indexes are
 * backfilled once on open; empty stores choose their dimensions on first write.
 */
type SqliteDatabase = Pick<DatabaseSync, 'exec' | 'prepare' | 'close'>

export interface SqliteVectorStoreOptions {
  path: string
  /** Recorded into stats; a different model requires clearing the old chunks. */
  model?: string
  /** Where an optional sqlite-vec dependency installed by the host resolves. */
  baseDir?: string | null
  /** Supply a real SQLite database with sqlite-vec already loaded. */
  openDatabase?: (path: string) => Promise<SqliteDatabase> | SqliteDatabase
}

interface ChunkRow {
  id: string
  text: string
  metadata: string
  embedding: string
}

async function openDatabase(path: string, baseDir?: string | null): Promise<SqliteDatabase> {
  let sqlite: typeof NodeSqlite
  try {
    sqlite = await import('node:sqlite')
    if (typeof sqlite.DatabaseSync.prototype.loadExtension !== 'function') {
      throw new Error('The node:sqlite extension API is unavailable.')
    }
  } catch (cause) {
    throw new Error(
      'knowledge.store "sqlite" needs Node 22.13 or newer for extension loading.\n' +
        '  Upgrade Node, or use knowledge.store.type: memory for development.',
      { cause },
    )
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new sqlite.DatabaseSync(path, { allowExtension: true })
  try {
    const vec = (await importOptional('sqlite-vec', { from: [baseDir] })) as {
      getLoadablePath?: () => string
      load?: (db: DatabaseSync) => void
    }
    if (typeof vec.load === 'function') vec.load(db)
    else if (typeof vec.getLoadablePath === 'function') db.loadExtension(vec.getLoadablePath())
    else throw new Error('sqlite-vec exposes neither load nor getLoadablePath.')
    db.prepare('SELECT vec_version()').get()
    db.enableLoadExtension(false)
    return db
  } catch (cause) {
    db.close()
    if (isModuleNotFound(cause, 'sqlite-vec')) {
      throw new Error(
        'knowledge.store "sqlite" requires the optional dependency sqlite-vec.\n' +
          '  Install it:  pnpm add sqlite-vec@^0.1.9',
        { cause },
      )
    }
    throw new Error(
      'Could not load sqlite-vec. Check that its prebuilt binary supports this platform ' +
        'and that optional dependencies were installed.\n' +
        '  Reinstall with: pnpm add sqlite-vec@^0.1.9',
      { cause },
    )
  }
}

export async function createSqliteVectorStore(
  options: SqliteVectorStoreOptions,
): Promise<VectorStore> {
  const db = options.openDatabase
    ? await options.openDatabase(options.path)
    : await openDatabase(options.path, options.baseDir)
  try {
    return new SqliteVectorStore(db, options.model ?? '')
  } catch (error) {
    db.close()
    throw error
  }
}

class SqliteVectorStore implements VectorStore {
  #db: SqliteDatabase
  #model: string
  #writeModel: string
  #dimensions: number | undefined

  constructor(db: SqliteDatabase, model: string) {
    this.#db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL,
        metadata TEXT NOT NULL, source_id TEXT NOT NULL, url TEXT NOT NULL, updated_at TEXT NOT NULL,
        embedding_zero INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id);
      CREATE INDEX IF NOT EXISTS chunks_url ON chunks(url);
      CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const columns = db.prepare('PRAGMA table_info(chunks)').all() as { name: string }[]
    if (!columns.some((column) => column.name === 'embedding_zero')) {
      db.exec('ALTER TABLE chunks ADD COLUMN embedding_zero INTEGER NOT NULL DEFAULT 0')
    }
    db.exec('CREATE INDEX IF NOT EXISTS chunks_zero ON chunks(embedding_zero)')
    this.#model = this.#meta('model') ?? model
    this.#writeModel = model || this.#model
    const dimensions = this.#meta('dimensions')
    if (dimensions !== undefined) this.#dimensions = validateDimensions(Number(dimensions))
    const indexed = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunks_vec'").get()
    if (indexed !== undefined) {
      if (this.#dimensions === undefined)
        throw new Error('SQLite vector index is missing dimensions metadata.')
      return
    }
    const first = db.prepare('SELECT embedding FROM chunks ORDER BY rowid LIMIT 1').get() as
      { embedding: string } | undefined
    if (first === undefined && this.#dimensions === undefined) return
    const dimension =
      this.#dimensions ?? vector(JSON.parse(first!.embedding) as number[]).dimensions
    this.#transaction(() => {
      this.#createIndex(dimension)
      const rows = db
        .prepare('SELECT CAST(rowid AS TEXT) AS rowid, embedding FROM chunks')
        .all() as {
        rowid: string
        embedding: string
      }[]
      const insert = db.prepare('INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)')
      const markZero = db.prepare('UPDATE chunks SET embedding_zero = ? WHERE rowid = ?')
      for (const row of rows) {
        const encoded = vector(JSON.parse(row.embedding) as number[], dimension)
        markZero.run(Number(encoded.zero), BigInt(row.rowid))
        if (!encoded.zero) insert.run(BigInt(row.rowid), encoded.json)
      }
    })
    this.#dimensions = dimension
  }

  #meta(key: string): string | undefined {
    return (
      this.#db.prepare('SELECT value FROM store_meta WHERE key = ?').get(key) as
        { value: string } | undefined
    )?.value
  }

  #setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        'INSERT INTO store_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  #transaction(action: () => void): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      action()
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #createIndex(dimensions: number): void {
    validateDimensions(dimensions)
    this.#db.exec(
      `CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[${dimensions}] distance_metric=cosine)`,
    )
    this.#setMeta('dimensions', String(dimensions))
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return
    const dimensions = vector(chunks[0]!.embedding).dimensions
    const encoded = chunks.map((chunk) => vector(chunk.embedding, dimensions))
    const count = (this.#db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
    if (count > 0 && this.#dimensions !== dimensions) {
      throw new Error(
        `SQLite embedding dimensions changed from ${this.#dimensions} to ${dimensions}; clear the index and re-ingest with --force.`,
      )
    }
    if (count > 0 && this.#model !== this.#writeModel) {
      throw new Error('SQLite embedding model changed; clear the index and re-ingest with --force.')
    }
    this.#transaction(() => {
      if (this.#dimensions !== dimensions) {
        this.#db.exec('DROP TABLE IF EXISTS chunks_vec')
        this.#createIndex(dimensions)
      }
      const insert = this.#db.prepare(`
        INSERT INTO chunks(id, text, embedding, metadata, source_id, url, updated_at, embedding_zero) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          text = excluded.text, embedding = excluded.embedding, metadata = excluded.metadata,
          source_id = excluded.source_id, url = excluded.url, updated_at = excluded.updated_at,
          embedding_zero = excluded.embedding_zero
      `)
      const removeVector = this.#db.prepare(
        'DELETE FROM chunks_vec WHERE rowid = (SELECT rowid FROM chunks WHERE id = ?)',
      )
      const insertVector = this.#db.prepare(
        'INSERT INTO chunks_vec(rowid, embedding) SELECT rowid, ? FROM chunks WHERE id = ?',
      )
      for (const [index, chunk] of chunks.entries()) {
        removeVector.run(chunk.id)
        insert.run(
          chunk.id,
          chunk.text,
          JSON.stringify(chunk.embedding),
          JSON.stringify(chunk.metadata),
          chunk.metadata.sourceId,
          chunk.metadata.url,
          chunk.metadata.updatedAt,
          Number(encoded[index]!.zero),
        )
        if (!encoded[index]!.zero) insertVector.run(encoded[index]!.json, chunk.id)
      }
      this.#setMeta('model', this.#writeModel)
      this.#setMeta('lastIndexed', new Date().toISOString())
    })
    this.#dimensions = dimensions
    this.#model = this.#writeModel
  }

  async query(embedding: number[], opts: QueryOptions): Promise<ScoredChunk[]> {
    if (!Number.isSafeInteger(opts.topK) || opts.topK < 0)
      throw new Error('topK must be a non-negative integer.')
    if (opts.topK === 0 || this.#dimensions === undefined) return []
    const encoded = vector(embedding, this.#dimensions)
    const { sql, params } = metadataFilter(opts.filter)
    if (encoded.zero) {
      const rows = this.#db
        .prepare(`SELECT c.* FROM chunks c WHERE ${sql} ORDER BY c.rowid LIMIT ?`)
        .all(...params, opts.topK) as unknown as ChunkRow[]
      return (opts.minScore ?? 0) > 0
        ? []
        : rows.map((row) => ({ chunk: rowToChunk(row), score: 0 }))
    }
    const filtered =
      opts.filter === undefined || Object.keys(opts.filter).length === 0
        ? ''
        : `AND rowid IN (SELECT c.rowid FROM chunks c WHERE ${sql})`
    // vec0 caps a KNN request at 4096. Larger requests still use the extension
    // for distance calculation, with SQLite ordering and limiting the rows.
    const search =
      opts.topK > 4096
        ? `
      SELECT c.*, 1 - vec_distance_cosine(v.embedding, ?) AS score
      FROM chunks_vec v JOIN chunks c ON c.rowid = v.rowid
      WHERE ${sql} ORDER BY score DESC, c.rowid LIMIT ?
    `
        : `
      SELECT c.*, 1 - v.distance AS score FROM (
        SELECT rowid, distance FROM chunks_vec
        WHERE embedding MATCH ? AND k = ? ${filtered} ORDER BY distance
      ) v JOIN chunks c ON c.rowid = v.rowid ORDER BY v.distance, c.rowid
    `
    const bindings: SQLInputValue[] =
      opts.topK > 4096
        ? [encoded.json, ...params, opts.topK]
        : [encoded.json, opts.topK, ...(filtered === '' ? [] : params)]
    const rows = this.#db.prepare(search).all(...bindings) as unknown as (ChunkRow & {
      score: number
    })[]
    const scored = rows.map((row) => ({
      chunk: rowToChunk(row),
      score: Math.max(-1, Math.min(1, row.score)),
    }))
    // Cosine of zero is undefined in vec0. Exclude zero vectors from its KNN
    // table and merge their conventional score of zero after native ranking.
    if ((opts.minScore ?? 0) <= 0) {
      const zeros = this.#db
        .prepare(
          `
        SELECT c.* FROM chunks c WHERE c.embedding_zero = 1 AND ${sql}
        ORDER BY c.rowid LIMIT ?
      `,
        )
        .all(...params, opts.topK) as unknown as ChunkRow[]
      scored.push(...zeros.map((row) => ({ chunk: rowToChunk(row), score: 0 })))
    }
    return scored
      .filter((entry) => opts.minScore === undefined || entry.score >= opts.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK)
  }

  async documentChunks(url: string): Promise<Chunk[]> {
    const rows = this.#db
      .prepare(
        "SELECT * FROM chunks WHERE url = ? ORDER BY json_extract(metadata, '$.ordinal'), rowid",
      )
      .all(url) as unknown as ChunkRow[]
    return rows.map(rowToChunk)
  }

  async deleteBySource(sourceId: string): Promise<void> {
    this.#transaction(() => {
      if (this.#dimensions !== undefined)
        this.#db
          .prepare(
            'DELETE FROM chunks_vec WHERE rowid IN (SELECT rowid FROM chunks WHERE source_id = ?)',
          )
          .run(sourceId)
      this.#db.prepare('DELETE FROM chunks WHERE source_id = ?').run(sourceId)
    })
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    this.#transaction(() => {
      const remove = this.#db.prepare('DELETE FROM chunks WHERE id = ?')
      const removeVector =
        this.#dimensions === undefined
          ? undefined
          : this.#db.prepare(
              'DELETE FROM chunks_vec WHERE rowid = (SELECT rowid FROM chunks WHERE id = ?)',
            )
      for (const id of ids) {
        removeVector?.run(id)
        remove.run(id)
      }
    })
  }

  async stats(): Promise<VectorStoreStats> {
    const chunks = this.#db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
    const documents = this.#db.prepare('SELECT COUNT(DISTINCT url) AS n FROM chunks').get() as {
      n: number
    }
    return {
      chunks: chunks.n,
      documents: documents.n,
      model: this.#model,
      lastIndexed: this.#meta('lastIndexed') ?? new Date(0).toISOString(),
    }
  }

  async close(): Promise<void> {
    this.#db.close()
  }
}

function validateDimensions(dimensions: number): number {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192)
    throw new Error('SQLite embeddings must have between 1 and 8192 dimensions.')
  return dimensions
}

function vector(
  embedding: number[],
  expected?: number,
): { json: string; zero: boolean; dimensions: number } {
  const dimensions = validateDimensions(embedding.length)
  if (expected !== undefined && dimensions !== expected)
    throw new Error(`SQLite embedding has ${dimensions} dimensions; expected ${expected}.`)
  const floats = Array.from(embedding, Math.fround)
  if (embedding.some((n) => !Number.isFinite(n)) || floats.some((n) => !Number.isFinite(n)))
    throw new Error('SQLite embeddings must contain finite float32 values.')
  const max = Math.max(...floats.map(Math.abs))
  const zero = max === 0
  // Cosine is scale invariant. Unit vectors avoid overflow/underflow in vec0's
  // float32 norm calculation while the original embedding stays in chunks.
  const scaled = zero ? floats : floats.map((n) => n / max)
  const norm = zero ? 1 : Math.sqrt(scaled.reduce((sum, n) => sum + n * n, 0))
  return { json: JSON.stringify(scaled.map((n) => Math.fround(n / norm))), zero, dimensions }
}

/** Parameterize keys as well as values and retain strict JSON primitive equality. */
function metadataFilter(filter?: Record<string, unknown>): {
  sql: string
  params: SQLInputValue[]
} {
  const params: SQLInputValue[] = []
  const terms = Object.entries(filter ?? {}).map(([key, value]) => {
    if (value === undefined) {
      params.push(key)
      return 'NOT EXISTS (SELECT 1 FROM json_each(c.metadata) WHERE key = ?)'
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return '0'
    const types = typeof value === 'number' ? "type IN ('integer', 'real')" : 'type = ?'
    params.push(key)
    if (typeof value !== 'number')
      params.push(value === null ? 'null' : typeof value === 'boolean' ? String(value) : 'text')
    params.push(typeof value === 'boolean' ? Number(value) : (value as SQLInputValue))
    return `EXISTS (SELECT 1 FROM json_each(c.metadata) WHERE key = ? AND ${types} AND atom IS ?)`
  })
  return { sql: terms.length === 0 ? '1' : terms.join(' AND '), params }
}

function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    text: row.text,
    embedding: JSON.parse(row.embedding) as number[],
    metadata: JSON.parse(row.metadata) as Chunk['metadata'],
  }
}
