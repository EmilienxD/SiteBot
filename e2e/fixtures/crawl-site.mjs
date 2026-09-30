// Offline site + real ingest/store/server/widget for crawler browser acceptance.
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateConfig } from '../../packages/config/dist/index.js'
import { MemoryVectorStore } from '../../packages/core/dist/index.js'
import { createNodeHandler } from '../../packages/server/dist/node.js'
import { runIngest } from '../../packages/ingest/dist/index.js'

export async function startCrawlSite(port = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'sitebot-crawl-browser-'))
  const store = new MemoryVectorStore()
  const state = {
    requests: [],
    content: 'JAVASCRIPT-KNOWLEDGE: Aurora deliveries arrive in seven days.',
    retries: 0,
    failApi: false,
  }
  let baseUrl
  let handler
  const html = (body) => `<html><head><title>Aurora Docs</title></head><body>${body}</body></html>`
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    state.requests.push({ path: pathname, ua: req.headers['user-agent'], at: Date.now() })
    try {
      if (pathname.startsWith('/api/chat')) return await handler(req, res)
      if (pathname.startsWith('/widget/')) {
        const path = resolve('packages/widget/dist', pathname.slice('/widget/'.length))
        if (
          !path.startsWith(resolve('packages/widget/dist') + '\\') &&
          !path.startsWith(resolve('packages/widget/dist') + '/')
        )
          throw new Error('invalid asset')
        res.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css')
        res.end(await readFile(path))
        return
      }
      switch (pathname) {
        case '/robots.txt':
          res.end('User-agent: *\nDisallow: /blocked')
          break
        case '/sitemap.xml':
          res.end(
            `<urlset>${['/spa', '/blocked', '/redirect'].map((p) => `<url><loc>${baseUrl}${p}</loc></url>`).join('')}</urlset>`,
          )
          break
        case '/seed':
          res.end(
            html(
              '<main><h1>Aurora</h1><p>Public Aurora delivery documentation.</p><a href="/spa">Delivery</a><a href="/blocked">Private</a><a href="/redirect">Redirect</a></main>',
            ),
          )
          break
        case '/spa':
          res.setHeader('etag', '"unchanged-shell"')
          res.setHeader('set-cookie', 'fixture-session=spa; Path=/; HttpOnly; SameSite=Lax')
          res.end(html('<main id="app"></main><script src="/app.js"></script>'))
          break
        case '/app.js':
          res.setHeader('content-type', 'text/javascript')
          res.end(
            `fetch('/blocked-api').catch(() => {}); fetch('/data').then(r => r.json()).then(data => { document.querySelector('#app').innerHTML = '<h1>Delivery guide</h1><p>' + data.content + '</p><a href="/dynamic">More details</a>' })`,
          )
          break
        case '/data':
          if (!req.headers.cookie?.includes('fixture-session=spa')) {
            res.statusCode = 401
            res.end('missing SPA bootstrap cookie')
            break
          }
          if (state.failApi || state.retries++ === 0) {
            res.writeHead(503, { 'retry-after': '0' })
            res.end('retry')
            break
          }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ content: state.content }))
          break
        case '/dynamic':
          res.end(
            html(
              '<main><h1>Details</h1><p>DYNAMIC-LINK: Delivery tracking is sent by email.</p></main>',
            ),
          )
          break
        case '/redirect':
          res.writeHead(302, { location: '/blocked' })
          res.end()
          break
        case '/blocked':
        case '/blocked-api':
          res.end(
            html(
              '<main><h1>Private</h1><p>ROBOTS-BLOCKED-SECRET: This must never reach the knowledge index.</p></main>',
            ),
          )
          break
        case '/ingest': {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const settings = JSON.parse(Buffer.concat(chunks).toString() || '{}')
          const config = makeConfig(settings)
          const report = await runIngest(config, {
            manifestDir: directory,
            store,
            embedder: {
              embedBatch: async (texts) => ({
                embeddings: texts.map(() => [1, 0]),
                tokens: texts.length * 10,
              }),
            },
          })
          const hits = await store.query([1, 0], { topK: 100 })
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ report, text: hits.map((hit) => hit.chunk.text).join('\n') }))
          break
        }
        case '/verify':
          res.end(
            html(`<main><h1>Crawling acceptance fixture</h1><p>Real ingestion, retrieval and widget; offline model and embeddings.</p><button id="ingest">Ingest JavaScript site</button><pre id="result">Ready</pre></main>
            <script>document.querySelector('#ingest').onclick = async () => { const r = await fetch('/ingest', {method: 'POST', body: JSON.stringify({renderJs:true})}); document.querySelector('#result').textContent = JSON.stringify(await r.json(), null, 2) }</script>
            <script type="module" src="/widget/sitebot.js" data-endpoint="/api/chat"></script>`),
          )
          break
        default:
          res.statusCode = 404
          res.end('missing')
      }
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: error.stack }))
    }
  })
  await new Promise((done) => server.listen(port, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  function makeConfig({ type = 'crawl', renderJs = true, respectRobots = true } = {}) {
    const result = validateConfig(
      {
        version: 1,
        name: 'Crawl test',
        mode: 'agent',
        backend: {
          provider: 'custom',
          model: 'scripted',
          module: `${resolve('e2e/fixtures/scripted-model.mjs')}#createModel`,
        },
        prompt: {
          system: 'Search the knowledge base to answer delivery questions.',
          includePageContext: false,
        },
        knowledge: {
          sources: [
            type === 'crawl'
              ? { type, id: 'web', url: `${baseUrl}/seed`, respectRobots }
              : { type, id: 'web', url: `${baseUrl}/sitemap.xml` },
          ],
          extract: { renderJs, minChars: 10 },
          chunk: { minTokens: 0 },
          embedding: { provider: 'openai', model: 'offline', dimensions: 2 },
          store: { type: 'memory' },
          retrieval: { mode: 'tool', topK: 10 },
        },
        storage: { type: 'memory' },
        telemetry: { enabled: false, logLevel: 'error' },
      },
      { env: {}, baseDir: process.cwd() },
    )
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    return result.value
  }
  handler = createNodeHandler(makeConfig(), {
    deps: {
      knowledge: {
        store,
        embedder: { modelId: 'offline', embed: async () => ({ embedding: [1, 0], tokens: 1 }) },
      },
    },
  })
  return {
    baseUrl,
    state,
    makeConfig,
    directory,
    store,
    close: async () => {
      await handler.dispose()
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const site = await startCrawlSite(Number(process.env.PORT ?? 4318))
  process.stdout.write(`${site.baseUrl}/verify\n`)
  process.on('SIGINT', async () => {
    await site.close()
    process.exit(0)
  })
}
