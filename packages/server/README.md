# @sitebot/server

Mounts the [SiteBot](https://github.com/EmilienxD/SiteBot) chat API (`/api/chat`, with `/config`,
`/feedback` and `/health`) on your server. Each framework has its own entry, so importing one never pulls
in another:

| Entry                     | For                                                                  |
| ------------------------- | -------------------------------------------------------------------- |
| `@sitebot/server/next`    | Next.js App Router route handlers                                    |
| `@sitebot/server/express` | Express middleware                                                   |
| `@sitebot/server/fastify` | A Fastify plugin                                                     |
| `@sitebot/server/hono`    | Hono middleware                                                      |
| `@sitebot/server/node`    | Plain `node:http`                                                    |
| `@sitebot/server/fetch`   | Any `(Request) => Response` runtime: Workers, Deno, Bun, Vercel Edge |

```bash
npm i @sitebot/server @sitebot/config @ai-sdk/anthropic
```

```ts
// Express
import express from 'express'
import { loadConfig } from '@sitebot/config/node'
import { createExpressMiddleware } from '@sitebot/server/express'

const config = await loadConfig(undefined, { dotenv: true })
const app = express()
app.use('/api/chat', createExpressMiddleware(config)) // before any body parser
app.listen(3000)
```

Install the SDK for your model provider alongside it (`@ai-sdk/anthropic`, `@ai-sdk/openai`, …).
`npx sitebot doctor` tells you if one is missing.

Guides for [Next.js](https://github.com/EmilienxD/SiteBot/tree/main/examples/nextjs), a
[separate server](https://github.com/EmilienxD/SiteBot/tree/main/examples/express-sidecar) and
[Cloudflare Workers](https://github.com/EmilienxD/SiteBot/tree/main/examples/cloudflare-worker) are in
the examples.
