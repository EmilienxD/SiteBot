import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '@sitebot/core'
import { createRouteHandlers } from './next.js'
import { lazySessionStore, withNodeRuntime } from './node-runtime.js'
import { chatBody, mockDeps, SESSION, streamedText, testConfig } from '../test/helpers.js'

/**
 * `storage.type: sqlite | redis | postgres | custom` validates, so every Node
 * adapter must be able to run it — the edge-safe session factory refuses to,
 * by design. `withNodeRuntime` is the one place that closes the gap.
 */

describe('withNodeRuntime', () => {
  it('serves a sqlite-backed agent end to end through a Node adapter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sitebot-sqlite-'))
    const config = testConfig({ storage: { type: 'sqlite', path: join(dir, 'sessions.db') } })
    const { POST, handler } = createRouteHandlers(config, { deps: mockDeps(['Stored ', 'reply.']) })
    const response = await POST(
      new Request('https://acme.com/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chatBody('Remember me')),
      }),
    )
    expect(response.status).toBe(200)
    expect(await streamedText(await response.text())).toBe('Stored reply.')
    // The transcript landed in the sqlite file, not in memory.
    const { createSqliteSessionStore } = await import('@sitebot/core/node')
    const reopened = await createSqliteSessionStore({ path: join(dir, 'sessions.db') })
    await vi.waitFor(async () =>
      expect((await reopened.get(SESSION))?.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]),
    )
    await reopened.dispose?.()
    await handler.dispose()
  })

  it('leaves memory storage to the engine and never overrides injected deps', () => {
    const memory = withNodeRuntime(testConfig({ storage: { type: 'memory' } }))
    expect(memory.deps?.sessionStore).toBeUndefined()
    expect(typeof memory.deps?.fetchImpl).toBe('function')

    const own = {} as SessionStore
    const injected = withNodeRuntime(
      testConfig({ storage: { type: 'sqlite', path: ':memory:' } }),
      {
        deps: { sessionStore: own },
      },
    )
    expect(injected.deps?.sessionStore).toBe(own)
  })
})

describe('lazySessionStore', () => {
  it('opens once, on first use', async () => {
    const open = vi.fn(async () => ({
      get: async () => null,
      set: async () => {},
      append: async (id: string) => ({ id, messages: [], createdAt: 0, updatedAt: 0 }),
      delete: async () => {},
    }))
    const store = lazySessionStore(open)
    expect(open).not.toHaveBeenCalled()
    await store.get('a')
    await store.get('b')
    expect(open).toHaveBeenCalledOnce()
  })

  it('retries opening after a failure instead of latching it', async () => {
    const open = vi
      .fn<() => Promise<SessionStore>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({
        get: async () => null,
        set: async () => {},
        append: async (id: string) => ({ id, messages: [], createdAt: 0, updatedAt: 0 }),
        delete: async () => {},
      })
    const store = lazySessionStore(open)
    await expect(store.get('a')).rejects.toThrow('db down')
    await expect(store.get('a')).resolves.toBeNull()
  })
})
