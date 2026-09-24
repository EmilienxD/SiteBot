import type { SessionStore, StoredSession } from '@sitebot/core'
import type { UIMessage } from 'ai'

/**
 * `SessionStore` over Workers KV — the four methods the engine needs.
 *
 * KV is eventually consistent across locations: a visitor's next message
 * almost always reaches the same location and reads its own write, but that
 * isn't guaranteed. That's fine for `mode: chat`. For `mode: agent`, where an
 * approval must be read back reliably, use a strongly consistent store
 * (Durable Objects, or Upstash Redis over REST) instead.
 */
export function createKvSessionStore(
  kv?: KVNamespace,
  options: { ttlSeconds?: number; maxMessages?: number } = {},
): SessionStore {
  if (kv === undefined)
    throw new Error(
      'createKvSessionStore needs the SESSIONS KV binding — it runs in the Worker, not in the CLI.',
    )
  const ttl = options.ttlSeconds ?? 86_400
  const maxMessages = options.maxMessages ?? 100
  const key = (id: string) => `session:${id}`

  const store: SessionStore = {
    async get(id) {
      return kv.get<StoredSession>(key(id), 'json')
    },
    async set(session) {
      const value: StoredSession = {
        ...session,
        messages: session.messages.slice(-maxMessages),
        updatedAt: Date.now(),
      }
      // KV's minimum TTL is 60 s.
      await kv.put(key(session.id), JSON.stringify(value), { expirationTtl: Math.max(60, ttl) })
    },
    async append(id, messages: UIMessage[]) {
      const now = Date.now()
      const session = (await store.get(id)) ?? { id, messages: [], createdAt: now, updatedAt: now }
      session.messages = [...session.messages, ...messages].slice(-maxMessages)
      await store.set(session)
      return session
    },
    async delete(id) {
      await kv.delete(key(id))
    },
  }
  return store
}
