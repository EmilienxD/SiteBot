import type { UIMessage } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../src/session/store.js'

/**
 * The session-store conformance suite — docs/02 §10, docs/01 §6.
 *
 * One file, every `storage.type`. The offline suite runs it against in-memory
 * driver stand-ins; the opt-in live suite runs the same cases against a real
 * Postgres and Redis, so the stand-ins cannot drift from the servers.
 */

export type SessionStoreFactory = (options: {
  now: () => number
  ttlSeconds: number
  max: number
}) => Promise<SessionStore>

const message = (id: string, text = id): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})

export function runSessionStoreConformance(name: string, make: SessionStoreFactory): void {
  describe(`${name} session store conformance`, () => {
    const stores: SessionStore[] = []
    afterEach(async () => {
      for (const store of stores.splice(0)) await store.dispose?.()
    })
    const setup = async (max = 100) => {
      let time = 1_000_000
      const store = await make({ now: () => time, ttlSeconds: 60, max })
      stores.push(store)
      return { store, advance: (ms: number) => (time += ms) }
    }

    it('returns null for an unknown session', async () => {
      const { store } = await setup()
      expect(await store.get('missing')).toBeNull()
    })

    it('round-trips a session, including checkpoint state and fingerprint', async () => {
      const { store } = await setup()
      await store.set({
        id: 's1',
        messages: [message('m1')],
        createdAt: 1,
        updatedAt: 1,
        fingerprint: '203.0.113|https://acme.com|abcd',
        state: { pending: { runId: 'r1' } },
      })
      const session = await store.get('s1')
      expect(session).toMatchObject({
        id: 's1',
        messages: [message('m1')],
        createdAt: 1,
        fingerprint: '203.0.113|https://acme.com|abcd',
        state: { pending: { runId: 'r1' } },
      })
    })

    it('append creates the session, then extends it in order', async () => {
      const { store } = await setup()
      await store.append('s1', [message('m1')])
      const after = await store.append('s1', [message('m2'), message('m3')])
      expect(after.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
      expect((await store.get('s1'))?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    })

    it('keeps only the newest maxMessagesPerSession messages', async () => {
      const { store } = await setup(3)
      await store.append(
        's1',
        ['a', 'b', 'c', 'd', 'e'].map((id) => message(id)),
      )
      expect((await store.get('s1'))?.messages.map((m) => m.id)).toEqual(['c', 'd', 'e'])
    })

    it('expires a session after ttlSeconds of inactivity, and activity renews it', async () => {
      const { store, advance } = await setup()
      await store.append('s1', [message('m1')])
      advance(50_000)
      await store.append('s1', [message('m2')])
      advance(50_000)
      expect(await store.get('s1')).not.toBeNull()
      advance(61_000)
      expect(await store.get('s1')).toBeNull()
    })

    it('isolates sessions and deletes one without touching another', async () => {
      const { store } = await setup()
      await store.append('s1', [message('one')])
      await store.append('s2', [message('two')])
      await store.delete('s1')
      expect(await store.get('s1')).toBeNull()
      expect((await store.get('s2'))?.messages[0]?.id).toBe('two')
    })

    it('does not share mutable state with the caller', async () => {
      const { store } = await setup()
      await store.append('s1', [message('m1')])
      const read = await store.get('s1')
      read!.messages.push(message('injected'))
      expect((await store.get('s1'))?.messages).toHaveLength(1)
    })
  })
}
