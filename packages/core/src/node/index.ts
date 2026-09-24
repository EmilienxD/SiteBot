import { isAbsolute, resolve } from 'node:path'
import type { Storage } from '@sitebot/config'
import { loadModuleExport, parseModuleSpec } from '../modules.js'
import { createSessionStore } from '../session/factory.js'
import type { SessionStore } from '../session/store.js'
import { createPostgresSessionStore, createRedisSessionStore } from './session-stores.js'
import { createSqliteSessionStore } from './sqlite-store.js'

/**
 * @sitebot/core/node — the Node-only surface.
 *
 * Anything that imports `node:*` belongs here: the stdio MCP transport, the
 * sqlite session store, filesystem-backed knowledge stores. The root entry
 * stays edge-compatible because none of this is reachable from it.
 *
 * Implemented across Phases 2, 5, 6 and 8.
 */

export const NODE_RUNTIME_MARKER = 'node' as const

export { createSqliteSessionStore } from './sqlite-store.js'
export type { SqliteSessionStoreOptions } from './sqlite-store.js'
export { createPostgresSessionStore, createRedisSessionStore } from './session-stores.js'
export type {
  PgLike,
  PostgresSessionStoreOptions,
  RedisLike,
  RedisSessionStoreOptions,
} from './session-stores.js'
export { createSafeFetch } from './safe-fetch.js'
export type { SafeFetch } from './safe-fetch.js'
export { connectStdioMcp } from './mcp.js'
export { createRedisRateLimitStore, RedisRateLimitStore } from './redis-rate-limit.js'
export type { RedisRateLimitStoreOptions } from './redis-rate-limit.js'
export { createNodeVectorStore } from './vector-store.js'
export { createSqliteVectorStore } from './vector-sqlite.js'
export type { SqliteVectorStoreOptions } from './vector-sqlite.js'
export { createPgVectorStore } from './vector-pgvector.js'
export type { PgVectorStoreOptions } from './vector-pgvector.js'
export { createUpstashVectorStore } from '../knowledge/upstash-store.js'
export type { UpstashVectorStoreOptions } from '../knowledge/upstash-store.js'

/**
 * Build the session store for a config, including the backends the edge-safe
 * `createSessionStore` refuses to construct.
 *
 * The split exists because `@sitebot/core`'s root entry must not import
 * `node:*` (docs/01 §3 rule 6). A Node host calls this and passes the result as
 * `deps.sessionStore`; an edge host never reaches the sqlite branch, because
 * nothing it imports references this module.
 */
export async function createNodeSessionStore(
  storage: Storage,
  options: { baseDir?: string | null | undefined } = {},
): Promise<SessionStore> {
  const common = {
    ttlSeconds: storage.ttlSeconds,
    maxMessagesPerSession: storage.maxMessagesPerSession,
  }
  switch (storage.type) {
    case 'sqlite':
      return createSqliteSessionStore({
        path: resolvePath(storage.path, options.baseDir),
        ...common,
      })
    case 'redis':
      return createRedisSessionStore({ url: storage.url, ...common })
    case 'postgres':
      return createPostgresSessionStore({ url: storage.url, ...common })
    case 'custom':
      return loadCustomSessionStore(storage.module, options.baseDir)
    default:
      return createSessionStore(storage)
  }
}

/**
 * `storage.type: custom` — docs/01 §6. The module exports either a
 * `SessionStore` or a factory returning one (sync or async).
 */
async function loadCustomSessionStore(
  spec: string,
  baseDir: string | null | undefined,
): Promise<SessionStore> {
  const { path, exportName } = parseModuleSpec(spec)
  const exported = await loadModuleExport(path, exportName, { baseDir, kind: 'Session store' })
  const store = (typeof exported === 'function' ? await exported() : exported) as SessionStore
  for (const method of ['get', 'set', 'append', 'delete'] as const) {
    if (typeof store?.[method] !== 'function') {
      throw new Error(
        `Session store module "${spec}" does not implement ${method}() — see the SessionStore interface.`,
      )
    }
  }
  return store
}

/** Relative store paths resolve against the config file, not the process cwd. */
function resolvePath(path: string, baseDir: string | null | undefined): string {
  if (path === ':memory:' || baseDir == null || isAbsolute(path)) return path
  return resolve(baseDir, path)
}
