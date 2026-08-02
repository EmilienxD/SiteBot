import type { Storage } from '@sitebot/config'
import { createSessionStore } from '../session/factory.js'
import type { SessionStore } from '../session/store.js'
import { createSqliteSessionStore } from './sqlite-store.js'

/**
 * @sitebot/core/node — the Node-only surface.
 *
 * Anything that imports `node:*` belongs here: the stdio MCP transport, the
 * sqlite session store, filesystem-backed knowledge stores. The root entry
 * stays edge-compatible because none of this is reachable from it.
 *
 * Implemented across Phases 2, 5 and 6.
 */

export const NODE_RUNTIME_MARKER = 'node' as const

export { createSqliteSessionStore } from './sqlite-store.js'
export type { SqliteSessionStoreOptions } from './sqlite-store.js'
export { createSafeFetch } from './safe-fetch.js'
export type { SafeFetch } from './safe-fetch.js'
export { connectStdioMcp } from './mcp.js'

/**
 * Build the session store for a config, including the backends the edge-safe
 * `createSessionStore` refuses to construct.
 *
 * The split exists because `@sitebot/core`'s root entry must not import
 * `node:*` (docs/01 §3 rule 6). A Node host calls this and passes the result as
 * `deps.sessionStore`; an edge host never reaches the sqlite branch, because
 * nothing it imports references this module.
 */
export async function createNodeSessionStore(storage: Storage): Promise<SessionStore> {
  if (storage.type === 'sqlite') {
    return createSqliteSessionStore({
      path: storage.path,
      ttlSeconds: storage.ttlSeconds,
      maxMessagesPerSession: storage.maxMessagesPerSession,
    })
  }

  return createSessionStore(storage)
}
