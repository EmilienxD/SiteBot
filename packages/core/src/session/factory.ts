import type { Storage } from '@sitebot/config'
import { EngineError } from '../stream/errors.js'
import { MemorySessionStore, NoneSessionStore, type SessionStore } from './store.js'

/**
 * `storage.type` → a `SessionStore`.
 *
 * Only the two edge-safe backends are constructible from here. `sqlite`,
 * `redis`, `postgres` and `custom` all need a Node runtime or a module load, so
 * they are built by `@sitebot/core/node` and passed in as `deps.sessionStore` —
 * which is also how a developer supplies their own (docs/01 §6).
 *
 * The error below therefore has to name the fix rather than just the problem:
 * "not supported" would be wrong, since the store *is* supported, just not
 * constructible from an edge bundle.
 */
export function createSessionStore(storage: Storage): SessionStore {
  switch (storage.type) {
    case 'none':
      return new NoneSessionStore()
    case 'memory':
      return new MemorySessionStore({
        ttlSeconds: storage.ttlSeconds,
        maxMessagesPerSession: storage.maxMessagesPerSession,
      })
    default:
      throw new EngineError('not_ready', {
        message: `Session storage "${storage.type}" needs a Node runtime.`,
        detail:
          `storage.type: ${storage.type} cannot be constructed from the edge-safe entry — ` +
          'build it with createNodeSessionStore() from @sitebot/core/node and pass it as deps.sessionStore',
        // `redis`, `postgres` and `custom` land with Phases 8 and 5; `sqlite`
        // is available today through the Node entry named above.
      })
  }
}
