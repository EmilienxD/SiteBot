import type { ResolvedConfig } from '@sitebot/config'
import { Hono } from 'hono'
import {
  createSiteBotHandler,
  DEFAULT_BASE_PATH,
  type SiteBotHandler,
  type SiteBotHandlerOptions,
} from './handler.js'

/**
 * `createServer` — the standalone app behind `sitebot serve`, topology T2.
 *
 * A sidecar is the deployment for sites that are not Node applications at all
 * (Django, Rails, WordPress, a static bucket): the host page loads the widget,
 * and this process answers `/api/chat`. Hono is the base because it runs
 * unmodified on Node, Bun, Deno and Workers, so `sitebot serve` and a Workers
 * deployment are the same app.
 *
 * `hono` is an optional peer dependency: only this entry and the hono adapter
 * import it, so a Next.js project never installs it.
 */

export interface CreateServerOptions extends SiteBotHandlerOptions {
  /** Mounted in addition to the four endpoints, for uptime checks at the root. */
  rootHealthPath?: string | false
}

export interface SiteBotServer {
  /** The Hono app. `fetch` is on it, so it drops into any runtime adapter. */
  app: Hono
  fetch: (request: Request) => Promise<Response>
  handler: SiteBotHandler
  dispose(): Promise<void>
}

export function createServer(
  config: ResolvedConfig,
  options: CreateServerOptions = {},
): SiteBotServer {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH
  const handler = createSiteBotHandler(config, options)
  const app = new Hono()

  app.all(basePath, (context) => handler(context.req.raw))
  app.all(`${basePath}/*`, (context) => handler(context.req.raw))

  // A sidecar is usually behind a load balancer that probes `/`. Pointing that
  // probe at the real health report rather than a static 200 means a broken
  // provider actually takes the instance out of rotation.
  const rootHealth = options.rootHealthPath ?? '/health'
  if (rootHealth !== false) {
    app.get(rootHealth, async () => {
      const report = await handler.engine.health()
      return Response.json(report, { status: report.status === 'error' ? 503 : 200 })
    })
  }

  return {
    app,
    fetch: (request: Request) => app.fetch(request) as Promise<Response>,
    handler,
    dispose: handler.dispose,
  }
}
