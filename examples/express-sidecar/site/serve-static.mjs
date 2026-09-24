// The no-Python fallback: serves the same pages as app.py on port 8000, so
// the cross-origin setup can be tried with Node alone. `/register/` maps to
// pages/register.html, the way the Django URLconf does.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 8000)
const routes = { '/': 'index.html', '/register/': 'register.html' }

createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  const file = routes[path]
  if (file === undefined) {
    response.writeHead(404).end('Not found')
    return
  }
  const html = await readFile(new URL(`./pages/${file}`, import.meta.url))
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
}).listen(port, () => console.warn(`site on http://localhost:${port}`))
