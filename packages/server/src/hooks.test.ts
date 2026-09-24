import { EngineError } from '@sitebot/core'
import { describe, expect, it } from 'vitest'
import { mockDeps, SESSION, testConfig } from '../test/helpers.js'
import { createSiteBotHandler } from './handler.js'

/** docs/04 §9: `onRequest` runs here, the only layer that holds the Request. */
const chat = () =>
  new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant': 'acme' },
    body: JSON.stringify({
      sessionId: SESSION,
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }),
  })

describe('onRequest', () => {
  it('sees the request and context, and lets it through by returning nothing', async () => {
    const seen: string[] = []
    const handler = createSiteBotHandler(
      testConfig({
        hooks: {
          onRequest: (request: Request, ctx: { sessionId: string }) => {
            seen.push(`${request.headers.get('x-tenant')}:${ctx.sessionId}`)
          },
        },
      } as never),
      { deps: mockDeps() },
    )
    const response = await handler(chat())
    expect(response.status).toBe(200)
    expect(seen).toEqual([`acme:${SESSION}`])
  })

  it('answers early when it returns a Response', async () => {
    const handler = createSiteBotHandler(
      testConfig({
        hooks: { onRequest: () => new Response('maintenance', { status: 503 }) },
      } as never),
      { deps: mockDeps() },
    )
    const response = await handler(chat())
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('maintenance')
  })

  it('rejects the request when it throws, mapped like any error', async () => {
    const handler = createSiteBotHandler(
      testConfig({
        hooks: {
          onRequest: () => {
            throw new EngineError('auth_required')
          },
        },
      } as never),
      { deps: mockDeps() },
    )
    const response = await handler(chat())
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'auth_required' })
  })
})
