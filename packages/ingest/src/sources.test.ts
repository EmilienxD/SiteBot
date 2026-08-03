import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateConfig, type ResolvedConfig } from '@sitebot/config'
import { loadOpenApi, loadSitemap, parseSitemap, parseYamlSubset } from './sources.js'

/**
 * Source tests against a fixture HTTP server — docs/06 §7. No real network:
 * the server binds 127.0.0.1 and its behaviour doubles as the assertion set
 * (a request log proves politeness headers, filters are answered by the
 * sitemap body).
 */

let server: Server
let port: number
const requestLog: { url: string; ua: string | undefined }[] = []

const PAGES: Record<string, string> = {
  '/sitemap.xml': `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>http://127.0.0.1:PORT/docs/getting-started</loc></url>
    <url><loc>http://127.0.0.1:PORT/docs/api</loc></url>
    <url><loc>http://127.0.0.1:PORT/pricing</loc></url>
    <url><loc>http://127.0.0.1:PORT/admin/panel</loc></url>
  </urlset>`,
}

function page(title: string, body: string): string {
  return `<html><head><title>${title}</title></head><body><nav>nav</nav><main><h1>${title}</h1><p>${body}</p></main><footer>foot</footer></body></html>`
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requestLog.push({ url: req.url ?? '', ua: req.headers['user-agent'] as string | undefined })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    switch (url.pathname) {
      case '/sitemap.xml': {
        // `<loc>`s are rewritten with the assigned port — a hard-coded port
        // would make this suite non-portable the first time 80 is taken.
        res.end(
          (PAGES['/sitemap.xml'] ?? '').replaceAll(
            'http://127.0.0.1:PORT',
            `http://127.0.0.1:${port}`,
          ),
        )
        return
      }
      case '/docs/getting-started':
        res.end(page('Getting Started', 'Install the package and write your first config file in a minute or two of total work.'))
        return
      case '/docs/api':
        res.end(page('API', 'The API surface is four endpoints: chat, config, feedback and health, each documented in detail.'))
        return
      case '/pricing':
        res.end(page('Pricing', 'Pricing is published openly. Starter is ten dollars, scale is fifty, and enterprise is annual.'))
        return
      case '/admin/panel':
        res.end(page('Admin', 'Administrative internals that must never be indexed by the knowledge pipeline.'))
        return
      default:
        res.statusCode = 404
        res.end('nope')
    }
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

function configWith(source: Record<string, unknown>, overrides: Record<string, unknown> = {}): ResolvedConfig {
  const result = validateConfig(
    {
      version: 1,
      name: 'Acme',
      backend: { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'test' },
      prompt: { system: 'You are a test assistant.' },
      knowledge: {
        sources: [source],
        embedding: { provider: 'ollama', model: 'nomic-embed-text' },
        store: { type: 'memory' },
        extract: { minChars: 10 },
        ...overrides,
      },
    },
    { env: {} },
  )
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

describe('sources: sitemap', () => {
  it('parses and filters the urlset', async () => {
    const config = configWith({
      type: 'sitemap',
      url: `http://127.0.0.1:${port}/sitemap.xml`,
      exclude: ['**/admin/**'],
    })
    const source = config.knowledge.sources[0]!
    if (source.type !== 'sitemap') throw new Error('bad test')
    const documents = await loadSitemap(source, config, { concurrency: 2, delayMs: 0 })
    const urls = documents.map((document) => document.url)
    expect(urls.some((url) => url.includes('getting-started'))).toBe(true)
    expect(urls.some((url) => url.includes('pricing'))).toBe(true)
    expect(urls.some((url) => url.includes('/admin/'))).toBe(false)
  })

  it('sends the sitebot user agent', async () => {
    const config = configWith({
      type: 'sitemap',
      url: `http://127.0.0.1:${port}/sitemap.xml`,
    })
    const source = config.knowledge.sources[0]!
    if (source.type !== 'sitemap') throw new Error('bad test')
    await loadSitemap(source, config, { concurrency: 1, delayMs: 0 })
    expect(requestLog.some((entry) => entry.ua?.includes('sitebot-ingest'))).toBe(true)
  })

  it('include acts as an allowlist', async () => {
    const config = configWith({
      type: 'sitemap',
      url: `http://127.0.0.1:${port}/sitemap.xml`,
      include: ['**/docs/**'],
    })
    const source = config.knowledge.sources[0]!
    if (source.type !== 'sitemap') throw new Error('bad test')
    const documents = await loadSitemap(source, config, { concurrency: 2, delayMs: 0 })
    expect(documents.every((document) => document.url.includes('/docs/'))).toBe(true)
  })

  it('parseSitemap tolerates whitespace', () => {
    expect(parseSitemap('<urlset><url><loc> https://a.test/x </loc></url></urlset>')).toEqual([
      'https://a.test/x',
    ])
  })
})

describe('sources: openapi', () => {
  it('renders each operation as a document', async () => {
    const spec = JSON.stringify({
      openapi: '3.0.0',
      paths: {
        '/users': {
          get: { summary: 'List users', parameters: [{ name: 'limit', in: 'query', required: false, description: 'Page size' }] },
          post: { summary: 'Create a user' },
        },
        '/users/{id}': { delete: { summary: 'Delete a user', description: 'Irreversible.' } },
      },
    })
    const documents = await loadOpenApi(
      { type: 'openapi', path: '/tmp/spec.json' },
      { readFile: async () => spec },
    )
    expect(documents).toHaveLength(3)
    const get = documents.find((document) => document.title.startsWith('GET /users'))
    expect(get?.text).toContain('List users')
    expect(get?.text).toContain('limit')
    expect(documents.find((d) => d.title.includes('DELETE'))?.text).toContain('Irreversible.')
  })

  it('reads the YAML subset', () => {
    const parsed = parseYamlSubset(`
openapi: 3.0.0
paths:
  /ping:
    get:
      summary: Ping the server
`) as { paths: Record<string, Record<string, { summary: string }>> }
    expect(parsed.paths['/ping']?.['get']?.summary).toBe('Ping the server')
  })
})
