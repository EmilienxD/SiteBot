// The real engine and Node adapter with an inspectable in-memory checkpoint.
// Only the model is scripted; expiry tests change the actual stored deadline.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../packages/config/dist/node/index.js'
import { MemorySessionStore } from '../../packages/core/dist/index.js'
import { createNodeHandler } from '../../packages/server/dist/node.js'

const config = await loadConfig(fileURLToPath(new URL('../chatbot.config.mjs', import.meta.url)))
const sessions = new MemorySessionStore()
const chat = createNodeHandler(config, { deps: { sessionStore: sessions } })
const pages = { '/': 'index.html', '/wholesale': 'wholesale.html' }
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:4320')
    if (url.pathname.startsWith('/api/chat')) return await chat(request, response)
    if (url.pathname === '/__test__/expire' && request.method === 'POST') {
      let text = ''
      for await (const chunk of request) text += chunk
      const session = await sessions.get(JSON.parse(text).sessionId)
      if (!session?.state?.pendingRun) {
        response.writeHead(404).end('No pending run')
        return
      }
      session.state.pendingRun.expiresAt = Date.now() - 1
      await sessions.set(session)
      response.writeHead(204).end()
      return
    }
    const page = pages[url.pathname]
    if (url.pathname === '/application-tools.js') {
      const script = await readFile(
        new URL('../../examples/plain-html/public/application-tools.js', import.meta.url),
      )
      response.writeHead(200, { 'content-type': 'application/javascript' }).end(script)
      return
    }
    if (url.pathname === '/styles.css') {
      const css = await readFile(
        new URL('../../examples/plain-html/public/styles.css', import.meta.url),
      )
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }).end(css)
      return
    }
    if (page) {
      const html = await readFile(
        new URL(`../../examples/plain-html/public/${page}`, import.meta.url),
      )
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
      return
    }
    if (/^\/sitebot(?:-panel|-shared)?\.js$/.test(url.pathname)) {
      const js = await readFile(
        new URL(`../../packages/widget/dist${url.pathname}`, import.meta.url),
      )
      response.writeHead(200, { 'content-type': 'application/javascript' }).end(js)
      return
    }
    response.writeHead(404).end('Not found')
  } catch (error) {
    console.error(error)
    response.writeHead(500).end('Fixture server error')
  }
})
server.listen(4320, '127.0.0.1', () =>
  console.warn('Approval verification ready at http://127.0.0.1:4320'),
)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections()
    server.close()
    void chat.dispose().then(() => process.exit(0))
  })
