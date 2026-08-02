import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UIMessage } from 'ai'
import type { SessionStore, SessionStoreOptions, StoredSession } from '../session/store.js'

/**
 * `storage.type: sqlite` — the single-node default for anything past a demo.
 *
 * Built on `node:sqlite`, which ships with Node itself (22.5+). The alternative
 * was `better-sqlite3`, a native module that has to be rebuilt per platform and
 * would land in the dependency tree of every project that installs
 * `@sitebot/core`. A built-in with a version floor is the cheaper trade, and
 * the error below says exactly what to do when the floor is not met.
 */

interface SqliteStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

export interface SqliteSessionStoreOptions extends SessionStoreOptions {
  /** File path, or `:memory:`. */
  path: string
  /** Injected by tests to avoid needing a real `node:sqlite`. */
  openDatabase?: (path: string) => SqliteDatabase
}

interface SessionRow {
  data: string
  updated_at: number
}

async function openWithNodeSqlite(path: string): Promise<SqliteDatabase> {
  let module: { DatabaseSync: new (path: string) => SqliteDatabase }
  try {
    module = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => SqliteDatabase
    }
  } catch (cause) {
    throw new Error(
      'storage.type "sqlite" needs the built-in node:sqlite module (Node 22.5 or newer).\n' +
        '  Upgrade Node, or switch to storage.type: memory for a single process, redis for several.',
      { cause },
    )
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  return new module.DatabaseSync(path)
}

export async function createSqliteSessionStore(
  options: SqliteSessionStoreOptions,
): Promise<SessionStore> {
  const db =
    options.openDatabase === undefined
      ? await openWithNodeSqlite(options.path)
      : options.openDatabase(options.path)

  const now = options.now ?? (() => Date.now())
  const ttlMs = (options.ttlSeconds ?? 2_592_000) * 1000
  const maxMessages = options.maxMessagesPerSession ?? 100

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions (updated_at);
  `)

  const selectOne = db.prepare('SELECT data, updated_at FROM sessions WHERE id = ?')
  const upsert = db.prepare(
    `INSERT INTO sessions (id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )
  const remove = db.prepare('DELETE FROM sessions WHERE id = ?')
  const sweep = db.prepare('DELETE FROM sessions WHERE updated_at < ?')

  const read = (id: string): StoredSession | null => {
    const row = selectOne.get(id) as SessionRow | undefined
    if (row === undefined) return null
    if (now() - row.updated_at > ttlMs) {
      remove.run(id)
      return null
    }
    return JSON.parse(row.data) as StoredSession
  }

  const write = (session: StoredSession): StoredSession => {
    const time = now()
    const trimmed: StoredSession = {
      ...session,
      messages: session.messages.slice(-maxMessages),
      updatedAt: time,
    }
    upsert.run(trimmed.id, JSON.stringify(trimmed), time)
    sweep.run(time - ttlMs)
    return trimmed
  }

  return {
    async get(id) {
      return read(id)
    },
    async set(session) {
      write(session)
    },
    async append(id: string, messages: UIMessage[]) {
      const time = now()
      const existing = read(id) ?? { id, messages: [], createdAt: time, updatedAt: time }
      return write({ ...existing, messages: [...existing.messages, ...messages] })
    },
    async delete(id) {
      remove.run(id)
    },
    async dispose() {
      db.close()
    },
  }
}
