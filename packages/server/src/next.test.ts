import { describe, expect, it } from 'vitest'
import { createRouteHandlers } from './next.js'
import { chatBody, mockDeps, streamedText, testConfig } from '../test/helpers.js'

// Next's installed NextRequest performs this normalization; the production
// standalone browser smoke exercises the actual framework class as well.
class NormalizedRequest extends Request {
  constructor(input: string, init?: RequestInit) {
    super(input, init)
    const originalUrl = this.url
    Object.defineProperty(this, 'url', { get: () => originalUrl.replace('127.0.0.1', 'localhost') })
  }
}

describe('Next request normalization', () => {
  it('keeps the original same-origin URL and POST body', async () => {
    const routes = createRouteHandlers(testConfig(), { deps: mockDeps(['Runtime answer.']) })
    try {
      const response = await routes.POST(
        new NormalizedRequest('http://127.0.0.1:3000/api/chat', {
          method: 'POST',
          headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
          body: JSON.stringify(chatBody()),
        }),
      )
      expect(response.status).toBe(200)
      expect(await streamedText(await response.text())).toBe('Runtime answer.')
    } finally {
      await routes.handler.dispose()
    }
  })

  it('does not grant another loopback origin or trust a spoofed forwarded host', async () => {
    const routes = createRouteHandlers(testConfig(), { deps: mockDeps() })
    try {
      for (const origin of ['http://localhost:3000', 'https://other.example']) {
        const response = await routes.GET(
          new NormalizedRequest('http://127.0.0.1:3000/api/chat/config', {
            headers: { origin, 'x-forwarded-host': new URL(origin).host },
          }),
        )
        expect(response.status).toBe(403)
      }
    } finally {
      await routes.handler.dispose()
    }
  })
})
