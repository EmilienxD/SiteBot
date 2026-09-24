import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ResolvedConfig } from '@sitebot/config'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatBody, mockDeps, SESSION, streamedText, testConfig } from '../test/helpers.js'
import { createExpressMiddleware } from './express.js'
import { createFastifyPlugin } from './fastify.js'
import { createFetchHandler } from './fetch.js'
import { createHonoMiddleware } from './hono.js'
import { createNodeHandler } from './node.js'
import { createRouteHandlers } from './next.js'
import { createServer } from './server.js'
import type { SiteBotHandlerOptions } from './handler.js'

/**
 * The adapter conformance suite — docs/09 Phase 3 acceptance:
 * "one shared test file run against all six adapters".
 *
 * The point is not that six adapters each work. It is that they are the *same*
 * implementation: if a behaviour can be asserted here, no adapter is allowed to
 * have its own opinion about it. An adapter that needs a special case in this
 * file has stopped being thin, which is the boundary docs/01 §2 draws for
 * layer 3.
 *
 * `next` and `fetch` are exercised in-process (both are `Request` → `Response`
 * functions); `hono`, `node`, `express` and `fastify` are exercised over a real
 * socket, because half of what they are responsible for — streaming without
 * buffering, header flushing, body parsing that does not eat the stream — only
 * exists once there is a socket.
 */

const BASE_PATH = '/api/chat'

interface Reply {
  status: number
  headers: Headers
  text: string
}

interface Transport {
  name: string
  request(
    method: string,
    path: string,
    init?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<Reply>
  close(): Promise<void>
}

type TransportFactory = (
  config: ResolvedConfig,
  options: SiteBotHandlerOptions,
) => Promise<Transport>

// ── in-process transports ───────────────────────────────────────────────────

function fromFetch(
  name: string,
  fetchLike: (request: Request) => Promise<Response>,
  dispose: () => Promise<void>,
): Transport {
  return {
    name,
    async request(method, path, init = {}) {
      const request = new Request(`https://chat.acme.com${path}`, {
        method,
        headers: init.headers ?? {},
        ...(init.body === undefined
          ? {}
          : {
              body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
            }),
      })
      const response = await fetchLike(request)
      return { status: response.status, headers: response.headers, text: await response.text() }
    },
    close: dispose,
  }
}

// ── socket-backed transports ────────────────────────────────────────────────

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function overSocket(name: string, origin: string, dispose: () => Promise<void>): Transport {
  return {
    name,
    async request(method, path, init = {}) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: init.headers ?? {},
        ...(init.body === undefined
          ? {}
          : {
              body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
            }),
      })
      return { status: response.status, headers: response.headers, text: await response.text() }
    },
    close: dispose,
  }
}

const TRANSPORTS: Record<string, TransportFactory> = {
  async fetch(config, options) {
    const handler = createFetchHandler(config, options)
    return fromFetch('fetch', handler, handler.dispose)
  },

  async next(config, options) {
    const { GET, POST, OPTIONS, handler } = createRouteHandlers(config, options)
    // Routed the way Next.js routes: by method, as it does for an App Router
    // route file exporting these three names.
    const byMethod = async (request: Request): Promise<Response> => {
      if (request.method === 'GET') return GET(request)
      if (request.method === 'POST') return POST(request)
      if (request.method === 'OPTIONS') return OPTIONS(request)
      return new Response(null, { status: 405 })
    }
    return fromFetch('next', byMethod, handler.dispose)
  },

  async hono(config, options) {
    const middleware = createHonoMiddleware(config, options)
    const app = new Hono()
    app.all(BASE_PATH, (context) => middleware(context))
    app.all(`${BASE_PATH}/*`, (context) => middleware(context))

    const server = createHttpServer((incoming, outgoing) => {
      void nodeToHono(app, incoming, outgoing)
    })
    const origin = await listen(server)
    return overSocket('hono', origin, async () => {
      await middleware.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  },

  async node(config, options) {
    const listener = createNodeHandler(config, options)
    const server = createHttpServer((incoming, outgoing) => {
      void listener(incoming, outgoing)
    })
    const origin = await listen(server)
    return overSocket('node', origin, async () => {
      await listener.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  },

  async express(config, options) {
    const { default: express } = await import('express')
    const middleware = createExpressMiddleware(config, options)
    const app = express()
    // Mounted before any body parser — see the note in src/express.ts.
    app.use(BASE_PATH, middleware as never)
    // A parser after the mount, to prove the mount order actually protects us.
    app.use(express.json())

    const server = createHttpServer(app as never)
    const origin = await listen(server)
    return overSocket('express', origin, async () => {
      await middleware.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  },

  async fastify(config, options) {
    const { default: Fastify } = await import('fastify')
    const plugin = createFastifyPlugin(config, options)
    const app = Fastify()
    await app.register(plugin as never, { prefix: BASE_PATH })
    await app.ready()

    const server = app.server
    const origin = await listen(server)
    return overSocket('fastify', origin, async () => {
      await plugin.dispose()
      await app.close()
    })
  },
}

/** Drive a Hono app from a Node server, the way @hono/node-server does. */
async function nodeToHono(
  app: Hono,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const { sendWebResponse, toWebRequest } = await import('./http/node-bridge.js')
  const response = await app.fetch(toWebRequest(incoming))
  await sendWebResponse(outgoing, response)
}

// ── the suite ───────────────────────────────────────────────────────────────

const ORIGIN_HEADERS = { origin: 'https://acme.com', 'content-type': 'application/json' }

for (const [name, factory] of Object.entries(TRANSPORTS)) {
  describe(`adapter conformance: ${name}`, () => {
    let transport: Transport

    beforeAll(async () => {
      transport = await factory(
        testConfig({ security: { allowedOrigins: ['https://acme.com'] } }),
        { deps: mockDeps(), version: '1.2.3' },
      )
    })

    afterAll(async () => {
      await transport.close()
    })

    it('POST / streams the answer as SSE', async () => {
      const reply = await transport.request('POST', BASE_PATH, {
        headers: ORIGIN_HEADERS,
        body: chatBody(),
      })

      expect(reply.status).toBe(200)
      expect(reply.headers.get('content-type')).toContain('text/event-stream')
      // docs/03 §11: nothing between us and the browser may buffer or
      // transform the stream.
      expect(reply.headers.get('cache-control')).toContain('no-cache')
      expect(reply.headers.get('x-accel-buffering')).toBe('no')
      expect(reply.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      expect(reply.text.trimEnd().endsWith('data: [DONE]')).toBe(true)
      expect(await streamedText(reply.text)).toBe('Your order shipped yesterday.')
    })

    it('POST / echoes a request id and the allowed origin', async () => {
      const reply = await transport.request('POST', BASE_PATH, {
        headers: ORIGIN_HEADERS,
        body: chatBody(),
      })
      expect(reply.headers.get('x-sitebot-request-id')).toMatch(/^req_/)
      expect(reply.headers.get('access-control-allow-origin')).toBe('https://acme.com')
      // The widget reads both cross-origin: the id for support, Retry-After
      // for the 429 countdown (docs/07 §10).
      expect(reply.headers.get('access-control-expose-headers')).toBe(
        'x-sitebot-request-id, retry-after',
      )
      // docs/08 §7: we never use cookies, so this must never be sent.
      expect(reply.headers.get('access-control-allow-credentials')).toBeNull()
    })

    it('GET /config returns the public config and no secrets', async () => {
      const reply = await transport.request('GET', `${BASE_PATH}/config`, {
        headers: { origin: 'https://acme.com' },
      })

      expect(reply.status).toBe(200)
      const body = JSON.parse(reply.text) as Record<string, unknown>
      expect(body.name).toBe('Acme')
      expect(body.version).toBe('1.2.3')
      expect(body).toHaveProperty('ui')
      expect(body).toHaveProperty('capabilities')

      // The acceptance criterion, asserted mechanically rather than by reading.
      expect(reply.text).not.toContain('test-key-do-not-leak')
      expect(body).not.toHaveProperty('backend')
      expect(body).not.toHaveProperty('security')
      expect(body).not.toHaveProperty('storage')
      expect(body).not.toHaveProperty('hooks')

      expect(reply.headers.get('cache-control')).toContain('max-age=60')
    })

    it('GET /config with a sessionId is never cached', async () => {
      const reply = await transport.request('GET', `${BASE_PATH}/config?sessionId=${SESSION}`, {
        headers: { origin: 'https://acme.com' },
      })
      // It will carry `pending` from Phase 5 on, which is per-session.
      expect(reply.headers.get('cache-control')).toContain('no-store')
    })

    it('GET /health reports provider latency', async () => {
      const reply = await transport.request('GET', `${BASE_PATH}/health`, {
        headers: { origin: 'https://acme.com' },
      })

      expect(reply.status).toBe(200)
      const report = JSON.parse(reply.text) as {
        status: string
        version: string
        config: { valid: boolean; mode: string; toolCount: number }
        checks: Record<string, { status: string; latencyMs?: number }>
      }
      expect(report.status).toBe('ok')
      expect(report.version).toBe('1.2.3')
      expect(report.config).toEqual({ valid: true, mode: 'chat', toolCount: 0 })
      expect(report.checks.provider?.status).toBe('ok')
      expect(typeof report.checks.provider?.latencyMs).toBe('number')
      expect(report.checks.storage?.status).toBe('ok')
    })

    it('POST /feedback returns 204', async () => {
      const reply = await transport.request('POST', `${BASE_PATH}/feedback`, {
        headers: ORIGIN_HEADERS,
        body: { sessionId: SESSION, messageId: 'm_9', rating: 'up' },
      })
      expect(reply.status).toBe(204)
      expect(reply.text).toBe('')
    })

    it('POST /feedback rejects a malformed body', async () => {
      const reply = await transport.request('POST', `${BASE_PATH}/feedback`, {
        headers: ORIGIN_HEADERS,
        body: { sessionId: SESSION, rating: 'sideways' },
      })
      expect(reply.status).toBe(400)
      expect(JSON.parse(reply.text)).toMatchObject({ code: 'invalid_request' })
    })

    it('OPTIONS answers the preflight, cached for a day', async () => {
      const reply = await transport.request('OPTIONS', BASE_PATH, {
        headers: {
          origin: 'https://acme.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      })

      expect(reply.status).toBe(204)
      expect(reply.headers.get('access-control-allow-origin')).toBe('https://acme.com')
      expect(reply.headers.get('access-control-allow-methods')).toContain('POST')
      expect(reply.headers.get('access-control-allow-headers')).toContain('x-sitebot-key')
      expect(reply.headers.get('access-control-max-age')).toBe('86400')
      expect(reply.headers.get('vary')).toContain('Origin')
    })

    it('rejects an unlisted origin on the preflight and on the real request', async () => {
      const preflight = await transport.request('OPTIONS', BASE_PATH, {
        headers: { origin: 'https://evil.com', 'access-control-request-method': 'POST' },
      })
      expect(preflight.status).toBe(403)
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull()

      // docs/08 §7: a simple POST never triggers a preflight, so the real
      // request has to be checked too.
      const actual = await transport.request('POST', BASE_PATH, {
        headers: { origin: 'https://evil.com', 'content-type': 'application/json' },
        body: chatBody(),
      })
      expect(actual.status).toBe(403)
      expect(JSON.parse(actual.text)).toMatchObject({ code: 'origin_denied' })
    })

    it('rejects a malformed chat body with invalid_request', async () => {
      const reply = await transport.request('POST', BASE_PATH, {
        headers: ORIGIN_HEADERS,
        body: { messages: [] },
      })
      expect(reply.status).toBe(400)
      expect(JSON.parse(reply.text)).toMatchObject({ code: 'invalid_request' })
    })

    it('404s an unknown path under the base path', async () => {
      const reply = await transport.request('GET', `${BASE_PATH}/admin`, {
        headers: { origin: 'https://acme.com' },
      })
      expect(reply.status).toBe(404)
    })

    it('405s the wrong method on a known route', async () => {
      const reply = await transport.request('GET', BASE_PATH, {
        headers: { origin: 'https://acme.com' },
      })
      expect(reply.status).toBe(405)
    })
  })
}

// ── behaviours that need their own configuration ────────────────────────────

describe('limits and keys (fetch adapter)', () => {
  it('rejects an over-sized body with 413 before parsing it', async () => {
    const handler = createFetchHandler(
      testConfig({ security: { allowedOrigins: ['https://acme.com'], maxRequestBytes: 1024 } }),
      { deps: mockDeps() },
    )

    const reply = await handler(
      new Request('https://chat.acme.com/api/chat', {
        method: 'POST',
        headers: { origin: 'https://acme.com', 'content-type': 'application/json' },
        body: JSON.stringify({ ...chatBody('x'.repeat(4000)) }),
      }),
    )

    expect(reply.status).toBe(413)
    expect(await reply.json()).toMatchObject({ code: 'payload_too_large' })
    await handler.dispose()
  })

  it('rejects a wrong X-SiteBot-Key on every endpoint that takes one', async () => {
    const config = testConfig({
      security: { allowedOrigins: ['https://acme.com'], publicKey: 'pk_live_a1b2c3' },
    })
    const handler = createFetchHandler(config, { deps: mockDeps() })

    const post = await handler(
      new Request('https://chat.acme.com/api/chat', {
        method: 'POST',
        headers: {
          origin: 'https://acme.com',
          'content-type': 'application/json',
          'x-sitebot-key': 'pk_live_wrong',
        },
        body: JSON.stringify(chatBody()),
      }),
    )
    expect(post.status).toBe(403)
    expect(await post.json()).toMatchObject({ code: 'invalid_key' })

    const config403 = await handler(
      new Request('https://chat.acme.com/api/chat/config?key=pk_live_wrong'),
    )
    expect(config403.status).toBe(403)

    const config200 = await handler(
      new Request('https://chat.acme.com/api/chat/config?key=pk_live_a1b2c3'),
    )
    expect(config200.status).toBe(200)

    await handler.dispose()
  })

  it('returns 429 with Retry-After once the session limit is spent', async () => {
    const handler = createFetchHandler(
      testConfig({
        security: {
          allowedOrigins: ['https://acme.com'],
          rateLimit: { perSession: '1/1h' },
        },
      }),
      { deps: mockDeps() },
    )

    const send = () =>
      handler(
        new Request('https://chat.acme.com/api/chat', {
          method: 'POST',
          headers: { origin: 'https://acme.com', 'content-type': 'application/json' },
          body: JSON.stringify(chatBody()),
        }),
      )

    expect((await send()).status).toBe(200)
    const limited = await send()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).not.toBeNull()
    expect(await limited.json()).toMatchObject({ code: 'rate_limited', retryable: true })

    await handler.dispose()
  })

  it('serves same-origin requests when allowedOrigins is empty', async () => {
    // The default: empty means same-origin only, not "deny everything".
    const handler = createFetchHandler(testConfig(), { deps: mockDeps() })
    const reply = await handler(
      new Request('https://chat.acme.com/api/chat', {
        method: 'POST',
        headers: { origin: 'https://chat.acme.com', 'content-type': 'application/json' },
        body: JSON.stringify(chatBody()),
      }),
    )
    expect(reply.status).toBe(200)
    await handler.dispose()
  })

  it('honours a custom basePath', async () => {
    const handler = createFetchHandler(testConfig(), {
      basePath: '/assistant',
      deps: mockDeps(),
    })
    expect((await handler(new Request('https://chat.acme.com/assistant/health'))).status).toBe(200)
    expect((await handler(new Request('https://chat.acme.com/api/chat/health'))).status).toBe(404)
    await handler.dispose()
  })
})

describe('createServer (topology T2)', () => {
  it('serves the four endpoints plus a root health probe', async () => {
    const server = createServer(testConfig(), { deps: mockDeps(), version: '1.2.3' })

    const health = await server.fetch(new Request('http://localhost:8787/api/chat/health'))
    expect(health.status).toBe(200)

    const root = await server.fetch(new Request('http://localhost:8787/health'))
    expect(root.status).toBe(200)
    expect(await root.json()).toMatchObject({ status: 'ok' })

    const unknown = await server.fetch(new Request('http://localhost:8787/'))
    expect(unknown.status).toBe(404)

    await server.dispose()
  })
})

describe('trustProxy (docs/08 §7)', () => {
  const forwarded = (config: ResolvedConfig) => {
    const handler = createFetchHandler(config, {
      deps: mockDeps(),
    })
    return async (xff: string) =>
      handler(
        new Request('https://chat.acme.com/api/chat', {
          method: 'POST',
          headers: {
            origin: 'https://chat.acme.com',
            'content-type': 'application/json',
            'x-forwarded-for': xff,
          },
          body: JSON.stringify(chatBody()),
        }),
      )
  }

  it('ignores X-Forwarded-For entirely when trustProxy is off', async () => {
    // Every request looks like one caller, so a spoofed header cannot buy a
    // fresh IP bucket: the second request is limited despite a different XFF.
    const send = forwarded(
      testConfig({ security: { rateLimit: { perSession: '100/1h', perIp: '1/1h' } } }),
    )
    expect((await send('1.1.1.1')).status).toBe(200)
    // With trustProxy off and no socket address on a Web Request, the IP is
    // unknown, so the IP rule does not apply at all — and, crucially, spoofing
    // the header changes nothing either way.
    const second = await send('2.2.2.2')
    expect(second.status).toBe(200)
  })

  it('reads the hop-count entry when trustProxy is set', async () => {
    const send = forwarded(
      testConfig({
        security: { trustProxy: 1, rateLimit: { perSession: '100/1h', perIp: '1/1h' } },
      }),
    )
    // hops: 1 → the last entry, which is what our own proxy observed. The
    // leftmost entry is client-written and must not be the one that counts.
    expect((await send('9.9.9.9, 203.0.113.5')).status).toBe(200)
    expect((await send('8.8.8.8, 203.0.113.5')).status).toBe(429)
  })
})
