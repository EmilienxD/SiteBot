import { describe, expect, it } from 'vitest'
import { MemoryRateLimitStore } from '@sitebot/core'
import { corsHeaders, preflightResponse } from './http/cors.js'
import { resolveClientIp } from './http/context.js'
import { testConfig } from '../test/helpers.js'

describe('network security', () => {
  const config = testConfig({ security: { allowedOrigins: ['https://app.example'] } })

  it('rejects unlisted origins on preflight and actual requests', () => {
    expect(
      preflightResponse({
        config,
        origin: 'https://evil.example',
        selfOrigin: 'https://chat.example',
      }).status,
    ).toBe(403)
    expect(() =>
      corsHeaders({ config, origin: 'https://evil.example', selfOrigin: 'https://chat.example' }),
    ).toThrow()
  })

  it('ignores XFF unless trustProxy is configured', () => {
    const headers = new Headers({ 'x-forwarded-for': '198.51.100.1, 10.0.0.4' })
    expect(resolveClientIp(headers, false, '203.0.113.8')).toBe('203.0.113.8')
    expect(resolveClientIp(headers, 1, '203.0.113.8')).toBe('10.0.0.4')
  })

  it('keeps concurrent sliding-window hits accurate', async () => {
    const store = new MemoryRateLimitStore({ now: () => 1_000 })
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.hit('ip:1', { limit: 10, windowMs: 60_000 })),
    )
    expect(results.filter((result) => result.allowed)).toHaveLength(10)
  })
})
