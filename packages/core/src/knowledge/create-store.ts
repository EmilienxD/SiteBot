import type { Knowledge } from '@sitebot/config'
import { EngineError } from '../stream/errors.js'
import { MemoryVectorStore } from './memory-store.js'
import type { VectorStore } from './store.js'
import { createUpstashVectorStore } from './upstash-store.js'

/**
 * The edge-safe half of `knowledge.store` → `VectorStore` (docs/06 §3.7).
 *
 * Two backends need nothing but `fetch`: in-RAM `memory` and `upstash`, which
 * is why docs/00's Workers topology (T3) pairs with Upstash. Everything else —
 * a persisted `memory` file, `sqlite`, `pgvector`, `custom` — needs a Node
 * runtime and is built by `createNodeVectorStore` from `@sitebot/core/node`,
 * which delegates back here for these two.
 */
export function isEdgeVectorStore(store: Knowledge['store']): boolean {
  return store.type === 'upstash' || (store.type === 'memory' && store.path === undefined)
}

export async function createVectorStore(
  store: Knowledge['store'],
  options: { model?: string } = {},
): Promise<VectorStore> {
  const model = options.model === undefined ? {} : { model: options.model }
  if (store.type === 'upstash')
    return createUpstashVectorStore({ url: store.url, token: store.token, ...model })
  if (store.type === 'memory' && store.path === undefined) return new MemoryVectorStore(model)
  throw new EngineError('not_ready', {
    message: `knowledge.store "${store.type}" needs a Node runtime.`,
    detail:
      'build it with createNodeVectorStore() from @sitebot/core/node; only memory (without a path) and upstash run on the edge',
  })
}
