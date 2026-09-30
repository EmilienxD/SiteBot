import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { load } from 'sqlite-vec'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSqliteVectorStore } from './vector-sqlite.js'
import { cosineSimilarity, type Chunk, type VectorStore } from '../knowledge/store.js'

const stores: VectorStore[] = []
const directories: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function chunk(id: string, embedding = [1, 0, 0], metadata: Record<string, unknown> = {}): Chunk {
  return {
    id,
    text: `Body ${id}`,
    embedding,
    metadata: {
      url: `https://example.com/${id}`,
      title: id,
      headingPath: [],
      sourceId: 'test',
      sourceType: 'text',
      contentHash: id,
      updatedAt: '2026-09-30T00:00:00Z',
      tokens: 10,
      ...metadata,
    },
  }
}

async function open(
  path = ':memory:',
  model = 'test-model',
  db?: DatabaseSync,
): Promise<VectorStore> {
  const store = await createSqliteVectorStore({
    path,
    model,
    ...(db === undefined ? {} : { openDatabase: () => db }),
  })
  stores.push(store)
  return store
}

function native(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { allowExtension: true })
  load(db)
  db.enableLoadExtension(false)
  return db
}

function disk(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sitebot-sqlite-'))
  directories.push(directory)
  return join(directory, 'nested', 'index.db')
}

async function close(store: VectorStore): Promise<void> {
  stores.splice(stores.indexOf(store), 1)
  await store.close()
}

describe('SQLite native vectors', () => {
  it('loads the installed extension, creates vec0, and ranks by cosine rather than magnitude', async () => {
    const db = native()
    const store = await open(':memory:', 'test-model', db)
    const diagonal = chunk('diagonal', [0.6, 0.8, 0])
    await store.upsert([chunk('large', [100, 0, 0]), diagonal, chunk('orthogonal', [0, 1, 0])])
    expect(db.prepare('SELECT vec_version() AS version').get()).toMatchObject({
      version: expect.stringMatching(/^v0\.1\./),
    })
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_vec'").get(),
    ).toMatchObject({ sql: expect.stringContaining('USING vec0') })
    expect(() => db.loadExtension('another-extension')).toThrow(/not allowed/)
    const hits = await store.query([1, 0, 0], { topK: 2 })
    expect(hits.map((h) => h.chunk.id)).toEqual(['large', 'diagonal'])
    expect(hits[0]!.score).toBeCloseTo(1, 6)
    expect(hits[1]!.score).toBeCloseTo(cosineSimilarity([1, 0, 0], diagonal.embedding), 6)
    expect(hits[1]!.chunk.embedding).toEqual(diagonal.embedding)
    // A native index change must affect search even though the preserved
    // original embedding in chunks has not changed.
    db.prepare(
      "UPDATE chunks_vec SET embedding = ? WHERE rowid = (SELECT rowid FROM chunks WHERE id = 'large')",
    ).run('[0,1,0]')
    expect((await store.query([1, 0, 0], { topK: 1 }))[0]!.chunk.id).toBe('diagonal')
  })

  it.each([1536, 8192])(
    'supports production-size %i-dimensional embeddings',
    async (dimensions) => {
      const store = await open()
      const embedding = Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0))
      await store.upsert([chunk('large-dimension', embedding)])
      expect((await store.query(embedding, { topK: 1 }))[0]!.score).toBeCloseTo(1)
    },
  )

  it('exercises the default loader and persists dimensions, model and search across reopen', async () => {
    const path = disk()
    let store = await open(path)
    expect(await store.query([1, 0, 0], { topK: 2 })).toEqual([])
    await store.upsert([chunk('one'), chunk('two', [0, 1, 0])])
    const before = await store.stats()
    await close(store)
    store = await open(path, '')
    expect(await store.stats()).toEqual(before)
    expect((await store.query([1, 0, 0], { topK: 1 }))[0]!.chunk.id).toBe('one')
    await expect(store.query([1, 0], { topK: 1 })).rejects.toThrow(/expected 3/)
  })

  it('filters before topK so less similar eligible chunks are still found', async () => {
    const store = await open()
    await store.upsert([
      ...Array.from({ length: 25 }, (_, i) => chunk(`excluded-${i}`, [1, 0, 0], { lang: 'en' })),
      chunk('eligible', [0.6, 0.8, 0], { lang: 'fr' }),
    ])
    const hits = await store.query([1, 0, 0], { topK: 1, filter: { lang: 'fr' }, minScore: 0.5 })
    expect(hits.map((h) => h.chunk.id)).toEqual(['eligible'])
    expect(
      await store.query([1, 0, 0], { topK: 1, filter: { lang: 'fr' }, minScore: 0.9 }),
    ).toEqual([])
  })

  it('supports requests beyond vec0’s native KNN limit with extension-calculated distances', async () => {
    const store = await open()
    await store.upsert([chunk('a'), chunk('b', [0, 1, 0], { lang: 'fr' })])
    expect((await store.query([1, 0, 0], { topK: 10_000 })).map((h) => h.chunk.id)).toEqual([
      'a',
      'b',
    ])
    expect(
      (await store.query([1, 0, 0], { topK: 10_000, filter: { lang: 'fr' } })).map(
        (h) => h.chunk.id,
      ),
    ).toEqual(['b'])
  })

  it('normalizes float32 magnitudes so native cosine does not overflow or underflow', async () => {
    const store = await open()
    await store.upsert([chunk('large', [1e30, 0, 0]), chunk('small', [0, 1e-30, 0])])
    expect((await store.query([1e30, 0, 0], { topK: 1 }))[0]!.score).toBeCloseTo(1)
    expect((await store.query([0, 1e-30, 0], { topK: 1 }))[0]!.chunk.id).toBe('small')
  })

  it('parameterizes malicious filter keys and preserves primitive types and missing fields', async () => {
    const store = await open()
    const key = "x' OR 1=1 --"
    await store.upsert([
      chunk('number', [1, 0, 0], { [key]: 'yes', tag: 1, enabled: true, nullable: null }),
      chunk('string', [1, 0, 0], { tag: '1', enabled: false }),
    ])
    for (const filter of [{ [key]: 'yes' }, { tag: 1 }, { enabled: true }, { nullable: null }]) {
      expect((await store.query([1, 0, 0], { topK: 1, filter })).map((h) => h.chunk.id)).toEqual([
        'number',
      ])
    }
    expect(
      (await store.query([1, 0, 0], { topK: 2, filter: { nullable: undefined } })).map(
        (h) => h.chunk.id,
      ),
    ).toEqual(['string'])
    expect(await store.query([1, 0, 0], { topK: 2, filter: { tag: {} } })).toEqual([])
  })

  it('updates and deletes vector entries alongside their chunks', async () => {
    const db = native()
    const store = await open(':memory:', 'test-model', db)
    await store.upsert([chunk('a'), chunk('b', [0, 1, 0], { sourceId: 'other' })])
    await store.upsert([chunk('a', [0, 0, 1])])
    expect((await store.query([0, 1, 0], { topK: 1 }))[0]!.chunk.id).toBe('b')
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get()).toMatchObject({ n: 2 })
    await store.deleteByIds(['b', 'unknown'])
    await store.deleteBySource('test')
    expect(await store.query([1, 0, 0], { topK: 2 })).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get()).toMatchObject({ n: 0 })
  })

  it('rolls back chunk updates, vector updates and metadata when a batch fails', async () => {
    const db = native()
    const store = await open(':memory:', 'test-model', db)
    await store.upsert([chunk('a')])
    const before = await store.stats()
    db.exec(
      "CREATE TRIGGER reject_insert BEFORE INSERT ON chunks WHEN NEW.id = 'fail' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    )
    await expect(store.upsert([chunk('a', [0, 1, 0]), chunk('fail')])).rejects.toThrow(
      /injected failure/,
    )
    expect(await store.stats()).toEqual(before)
    expect((await store.query([1, 0, 0], { topK: 1 }))[0]!.score).toBeCloseTo(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get()).toMatchObject({ n: 1 })
  })

  it('rolls back lazy index creation and remains usable after a failed first write', async () => {
    const db = native()
    const store = await open(':memory:', 'test-model', db)
    db.exec(
      "CREATE TRIGGER reject_insert BEFORE INSERT ON chunks WHEN NEW.id = 'fail' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    )
    await expect(store.upsert([chunk('a'), chunk('fail')])).rejects.toThrow(/injected failure/)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'chunks_vec'").get(),
    ).toBeUndefined()
    expect((await store.stats()).chunks).toBe(0)
    await store.upsert([chunk('valid', [1, 0])])
    expect((await store.query([1, 0], { topK: 1 }))[0]!.chunk.id).toBe('valid')
  })

  it.each(['source', 'ids'])('rolls back a failed delete by %s', async (kind) => {
    const db = native()
    const store = await open(':memory:', 'test-model', db)
    await store.upsert([chunk('a')])
    db.exec(
      "CREATE TRIGGER reject_delete BEFORE DELETE ON chunks BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    )
    await expect(
      kind === 'source' ? store.deleteBySource('test') : store.deleteByIds(['a']),
    ).rejects.toThrow(/injected failure/)
    expect((await store.query([1, 0, 0], { topK: 1 }))[0]!.chunk.id).toBe('a')
  })

  it('handles zero embeddings without corrupting cosine rankings or scores', async () => {
    const store = await open()
    await store.upsert([chunk('zero', [0, 0, 0]), chunk('positive'), chunk('negative', [-1, 0, 0])])
    const hits = await store.query([1, 0, 0], { topK: 3 })
    expect(hits.map((h) => [h.chunk.id, h.score])).toEqual([
      ['positive', 1],
      ['zero', 0],
      ['negative', -1],
    ])
    expect((await store.query([1, 0, 0], { topK: 1 }))[0]!.chunk.id).toBe('positive')
    expect((await store.query([0, 0, 0], { topK: 3 })).every((h) => h.score === 0)).toBe(true)
    expect(await store.query([0, 0, 0], { topK: 3, minScore: 0.1 })).toEqual([])
    await store.upsert([chunk('zero')])
    await store.upsert([chunk('positive', [0, 0, 0])])
    expect((await store.query([1, 0, 0], { topK: 1 }))[0]!.chunk.id).toBe('zero')
  })

  it('rejects invalid or inconsistent embeddings before writing any part of a batch', async () => {
    const store = await open()
    for (const embedding of [[], [NaN, 0, 0], [Infinity, 0, 0], [1e100, 0, 0]]) {
      await expect(store.upsert([chunk('a'), chunk('invalid', embedding)])).rejects.toThrow(
        /dimensions|finite/,
      )
      expect((await store.stats()).chunks).toBe(0)
    }
    await expect(store.upsert([chunk('a'), chunk('two', [1, 0])])).rejects.toThrow(/expected 3/)
    await store.upsert([chunk('a')])
    await expect(store.upsert([chunk('two', [1, 0])])).rejects.toThrow(/--force/)
    expect(await store.query([1, 0, 0], { topK: 0 })).toEqual([])
  })

  it('allows a new model and dimensions only after the existing corpus is cleared', async () => {
    const path = disk()
    let store = await open(path, 'old-model')
    await store.upsert([chunk('old')])
    await close(store)
    store = await open(path, 'new-model')
    expect((await store.stats()).model).toBe('old-model')
    await expect(store.upsert([chunk('new')])).rejects.toThrow(/model changed/)
    await store.deleteBySource('test')
    await store.upsert([chunk('new', [1, 0])])
    expect((await store.stats()).model).toBe('new-model')
    await close(store)
    store = await open(path, 'new-model')
    expect((await store.query([1, 0], { topK: 1 }))[0]!.chunk.id).toBe('new')
  })

  it('migrates an existing JSON-only SQLite corpus without losing content or metadata', async () => {
    const db = native()
    db.exec(`CREATE TABLE chunks (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL,
      metadata TEXT NOT NULL, source_id TEXT NOT NULL, url TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO store_meta VALUES ('model', 'legacy-model'), ('lastIndexed', '2026-08-01');`)
    const original = chunk('legacy')
    db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      original.id,
      original.text,
      JSON.stringify(original.embedding),
      JSON.stringify(original.metadata),
      'test',
      original.metadata.url,
      original.metadata.updatedAt,
    )
    const store = await open(':memory:', '', db)
    expect((await store.query([1, 0, 0], { topK: 1 }))[0]!.chunk).toEqual(original)
    expect(await store.stats()).toMatchObject({
      model: 'legacy-model',
      chunks: 1,
      lastIndexed: '2026-08-01',
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get()).toMatchObject({ n: 1 })
  })

  it('closes the database when an invalid legacy embedding prevents initialization', async () => {
    const db = native()
    db.exec(`CREATE TABLE chunks (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL,
      metadata TEXT NOT NULL, source_id TEXT NOT NULL, url TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO chunks VALUES ('bad', 'body', '[]', '{}', 'test', 'https://example.com', '2026-09-30');`)
    await expect(
      createSqliteVectorStore({ path: ':memory:', openDatabase: () => db }),
    ).rejects.toThrow(/dimensions/)
    expect(() => db.prepare('SELECT 1')).toThrow(/not open|closed/)
  })
})
