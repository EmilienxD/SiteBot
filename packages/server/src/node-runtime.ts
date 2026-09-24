import type { ResolvedConfig } from '@sitebot/config'
import type { SessionStore } from '@sitebot/core'
import {
  connectStdioMcp,
  createNodeSessionStore,
  createNodeVectorStore,
  createRedisRateLimitStore,
  createSafeFetch,
} from '@sitebot/core/node'
import type { SiteBotHandlerOptions } from './handler.js'

/**
 * Everything a Node host adds on top of the edge-safe handler, in one place —
 * so the Next.js, Express, Fastify, Node and standalone adapters cannot drift
 * apart on what "running on Node" means:
 *
 *  - the SSRF-hardened `fetch` for `http` tools (docs/08 §5),
 *  - the stdio MCP transport (docs/05 §4),
 *  - `security.rateLimit.store: redis` (docs/08 §8),
 *  - `storage.type: sqlite | redis | postgres | custom` (docs/02 §10), which
 *    the edge-safe `createSessionStore` deliberately refuses to construct,
 *  - the Node-only `knowledge.store` types (sqlite, pgvector, a persisted
 *    memory file, custom), for the same reason.
 *
 * Caller-supplied options always win, so a developer can still inject their
 * own store or fetch.
 */
export function withNodeRuntime(
  config: ResolvedConfig,
  options: SiteBotHandlerOptions = {},
): SiteBotHandlerOptions {
  const safe = createSafeFetch()
  const rateLimitStore =
    options.rateLimitStore ??
    (config.security.rateLimit.store === 'redis'
      ? createRedisRateLimitStore({ url: resolveRedisUrl(config) })
      : undefined)
  const needsNodeStore =
    options.deps?.sessionStore === undefined &&
    options.engine === undefined &&
    config.storage.type !== 'memory' &&
    config.storage.type !== 'none'
  return {
    ...options,
    vectorStoreFactory: options.vectorStoreFactory ?? createNodeVectorStore,
    ...(rateLimitStore === undefined ? {} : { rateLimitStore }),
    deps: {
      fetchImpl: safe.fetch,
      resolveHost: safe.resolveHost,
      connectStdioMcp,
      ...(needsNodeStore
        ? {
            sessionStore: lazySessionStore(() =>
              createNodeSessionStore(config.storage, { baseDir: config.$meta.baseDir }),
            ),
          }
        : {}),
      ...options.deps,
    },
  }
}

/**
 * A store that opens on first use. Handler construction is synchronous (a
 * Next.js route module exports its handlers at import time), while opening a
 * database is not — and a store that cannot be reached should fail the first
 * request with `not_ready`, not crash the import.
 */
export function lazySessionStore(open: () => Promise<SessionStore>): SessionStore {
  let store: Promise<SessionStore> | undefined
  const ready = () => {
    store ??= open().catch((error: unknown) => {
      // Let the next request retry instead of latching the failure.
      store = undefined
      throw error
    })
    return store
  }
  return {
    get: async (id) => (await ready()).get(id),
    set: async (session) => (await ready()).set(session),
    append: async (id, messages) => (await ready()).append(id, messages),
    delete: async (id) => (await ready()).delete(id),
    dispose: async () => {
      if (store !== undefined) await (await store).dispose?.()
    },
  }
}

function resolveRedisUrl(config: ResolvedConfig): string {
  const configured =
    config.security.rateLimit.url ??
    (config.storage.type === 'redis' ? config.storage.url : undefined)
  const value = configured ?? process.env.SITEBOT_REDIS_URL
  if (value === undefined || value === '') {
    throw new Error(
      'security.rateLimit.store is redis but no URL is configured; set security.rateLimit.url, storage.url, or SITEBOT_REDIS_URL',
    )
  }
  return value
}
