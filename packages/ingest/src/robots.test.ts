import { describe, expect, it } from 'vitest'
import { robotsAllows, robotsPolicy } from './robots.js'

const url = (path: string) => `https://example.test${path}`

describe('robots rules (RFC 9309)', () => {
  it.each([
    ['User-agent: *\nDisallow: /private', '/private/page', false],
    ['User-agent: *\nDisallow: /private\nAllow: /private/public', '/private/public/page', true],
    ['User-agent: *\nDisallow: /same\nAllow: /same', '/same', true],
    ['User-agent: *\nDisallow:', '/', true],
    ['User-agent: *\nDisallow: /*.pdf$', '/guide.pdf', false],
    ['User-agent: *\nDisallow: /*.pdf$', '/guide.pdf?download=1', true],
    ['User-agent: *\nDisallow: /*?secret=', '/guide?secret=yes', false],
    ['User-agent: *\nDisallow: /Case', '/case', true],
    ['User-agent: *\nDisallow: /caf%C3%A9', '/café', false],
    ['User-agent: *\nDisallow: /~admin', '/%7Eadmin', false],
    ['User-agent: *\nDisallow: /a%2Fb', '/a/b', true],
    ['User-agent: *\nDisallow: /a%2fb', '/a%2Fb', false],
    ['User-agent: *\nDisallow: /private # comment', '/private', false],
    ['User-agent: other\nDisallow: /', '/', true],
    ['User-agent: *\nDisallow: /\nUser-agent: SITEBOT-INGEST\nAllow: /', '/', true],
    [
      'User-agent: sitebot-ingest\nDisallow: /a\nUser-agent: sitebot-ingest\nDisallow: /b',
      '/b',
      false,
    ],
    ['User-agent: other\nUser-agent: sitebot-ingest\nDisallow: /', '/', false],
  ])('applies %s to %s', (rules, path, allowed) => {
    expect(robotsAllows(rules, url(path))).toBe(allowed)
  })

  it('caches concurrent lookups per origin and fetches other origins separately', async () => {
    const requests: string[] = []
    const allowed = robotsPolicy({
      fetchImpl: (async (input) => {
        requests.push(String(input))
        return new Response('User-agent: *\nDisallow: /private')
      }) as typeof fetch,
    })
    expect(
      await Promise.all([
        allowed(url('/')),
        allowed(url('/private')),
        allowed('https://other.test/'),
      ]),
    ).toEqual([true, false, true])
    expect(requests).toEqual(['https://example.test/robots.txt', 'https://other.test/robots.txt'])
  })

  it('allows missing rules but stops on unavailable rules', async () => {
    const policy = (status: number) =>
      robotsPolicy({
        maxRetries: 0,
        fetchImpl: (async () => new Response('', { status })) as typeof fetch,
      })
    expect(await policy(404)(url('/'))).toBe(true)
    await expect(policy(503)(url('/'))).rejects.toThrow(/503/)
    await expect(policy(429)(url('/'))).rejects.toThrow(/429/)
    await expect(
      robotsPolicy({
        fetchImpl: (async () => {
          throw new Error('offline')
        }) as typeof fetch,
      })(url('/')),
    ).rejects.toThrow('offline')
  })
})
