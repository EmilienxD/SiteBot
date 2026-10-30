import { createFetchHandler } from '@sitebot/server/fetch'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs fixture with no type declarations.
import { createModel } from '../../../e2e/fixtures/scripted-model.mjs'
import { createDeps, resolveConfig, type Env } from '../src/worker.js'

/**
 * examples/cloudflare-worker, request path only: its config, its deps and its
 * KV session store, with the scripted model in place of OpenAI. The bundle
 * itself is checked by `wrangler deploy --dry-run` in CI, and the edge-safety
 * of the packages by test/edge-bundle.test.ts.
 */
class FakeKv {
  readonly data = new Map<string, string>()
  async get(key: string, type?: 'json') {
    const value = this.data.get(key)
    return value === undefined ? null : type === 'json' ? JSON.parse(value) : value
  }
  async put(key: string, value: string) {
    this.data.set(key, value)
  }
  async delete(key: string) {
    this.data.delete(key)
  }
}

const SESSION = 's_01J9X8Y7Z6ABCDEFGHJKMNPQRS'

async function handler(env: Env) {
  const resolved = resolveConfig(env)
  const deps = await createDeps(resolved, env)
  return createFetchHandler(resolved, {
    deps: { ...deps, adapters: { openai: async (entry) => createModel(entry) } },
  })
}

describe('examples/cloudflare-worker', () => {
  it('serves config and a chat turn, and keeps the session in KV', async () => {
    const kv = new FakeKv()
    const env = { SESSIONS: kv, OPENAI_API_KEY: 'sk-test' } as unknown as Env
    const fetch = await handler(env)

    const config = await fetch(new Request('http://localhost:8787/api/chat/config'))
    expect(config.status).toBe(200)
    expect(await config.json()).toMatchObject({ name: 'Tidepool Tours' })

    const chat = await fetch(
      new Request('http://localhost:8787/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION,
          messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi there' }] }],
        }),
      }),
    )
    expect(chat.status).toBe(200)
    expect(await chat.text()).toContain('scripted model')

    const stored = JSON.parse(kv.data.get(`session:${SESSION}`) ?? 'null')
    expect(stored.messages.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'assistant',
    ])
  })
})
