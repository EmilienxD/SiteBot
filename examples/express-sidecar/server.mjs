// The chat sidecar: an Express server with the chat API and the widget bundle,
// and nothing else. The site itself is served elsewhere — here, by Django on
// another port — which makes every request from its pages cross-origin.
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import express from 'express'
import { loadConfig } from '@sitebot/config/node'
import { createExpressMiddleware } from '@sitebot/server/express'

// SITEBOT_CONFIG points at another config file; CI uses it for an offline model.
const config = await loadConfig(process.env.SITEBOT_CONFIG, { dotenv: true })
const port = Number(process.env.PORT ?? 8787)
const allowed = new Set(config.security.allowedOrigins)

const app = express()
app.disable('x-powered-by')

// The widget bundle. A <script type="module"> from another origin is fetched
// in CORS mode, so the bundle needs the same origin allowlist as the API —
// without it the browser refuses to run the script.
const widgetDir = dirname(createRequire(import.meta.url).resolve('@sitebot/widget/sitebot.js'))
app.use(
  '/widget',
  (request, response, next) => {
    const origin = request.headers.origin
    if (origin !== undefined && allowed.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin)
    }
    response.setHeader('Vary', 'Origin')
    next()
  },
  express.static(widgetDir, { index: false, maxAge: '1h' }),
)

// The chat API: /api/chat, /config, /feedback and /health. CORS, including
// the preflight, is handled inside from `security.allowedOrigins`. Mount it
// before any body parser — it reads the raw request stream.
const chat = createExpressMiddleware(config)
app.use('/api/chat', chat)

const server = app.listen(port, () => {
  console.warn(`sitebot sidecar on http://localhost:${port}`)
  console.warn(`  allowed origins: ${[...allowed].join(', ') || '(none — same-origin only)'}`)
})

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close()
    void chat.dispose().then(() => process.exit(0))
  })
