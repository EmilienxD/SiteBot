import { describe, expect, it } from 'vitest'
import { fetchPage, requestGate, requestScheduler, retryDelay } from './http.js'

describe('polite HTTP fetching', () => {
  it('caps active requests per host and releases slots after failures', async () => {
    const gate = requestGate(2)
    let active = 0
    let maximum = 0
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        gate('https://example.test/', async () => {
          active++
          maximum = Math.max(maximum, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active--
          if (index === 0) throw new Error('failed')
        }),
      ),
    )
    expect(maximum).toBe(2)
    expect(active).toBe(0)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5)
  })
  it.each([429, 503])('honors Retry-After and retries %s', async (status) => {
    const waits: number[] = []
    let requests = 0
    const result = await fetchPage('https://example.test/', {
      fetchImpl: (async () =>
        ++requests === 1
          ? new Response('', { status, headers: { 'retry-after': '2' } })
          : new Response('ok')) as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(result.body).toBe('ok')
    expect(requests).toBe(2)
    expect(waits).toEqual([2000])
  })

  it('accepts HTTP dates and falls back to exponential backoff', () => {
    const now = Date.parse('2026-10-01T00:00:00Z')
    expect(retryDelay('Thu, 01 Oct 2026 00:00:03 GMT', 0, now)).toBe(3000)
    expect(retryDelay('Wed, 30 Sep 2026 00:00:00 GMT', 0, now)).toBe(0)
    expect(retryDelay(null, 0)).toBe(1000)
    expect(retryDelay('bad', 1)).toBe(2000)
  })

  it('bounds retries and fails rather than removing temporarily unavailable documents', async () => {
    let requests = 0
    await expect(
      fetchPage('https://example.test/', {
        fetchImpl: (async () => {
          requests++
          return new Response('', { status: 503 })
        }) as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/503/)
    expect(requests).toBe(3)
  })

  it('checks redirect targets before issuing a request', async () => {
    const requests: string[] = []
    const result = await fetchPage('https://example.test/allowed', {
      allowed: async (url) => !url.endsWith('/private'),
      fetchImpl: (async (url) => {
        requests.push(String(url))
        return new Response('', { status: 302, headers: { location: '/private' } })
      }) as typeof fetch,
    })
    expect(result.status).toBe(403)
    expect(requests).toEqual(['https://example.test/allowed'])
  })

  it('spaces concurrent request starts to the same origin', async () => {
    const starts: number[] = []
    const before = requestScheduler({
      delayMs: 30,
      beforeRequest: async () => {
        starts.push(Date.now())
      },
    })
    await Promise.all([
      before('https://example.test/a'),
      before('https://example.test/b'),
      before('https://example.test/c'),
    ])
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(25)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(25)
  })
})
