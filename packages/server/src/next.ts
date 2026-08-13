import type { ResolvedConfig } from '@sitebot/config'
import { connectStdioMcp, createSafeFetch } from '@sitebot/core/node'
import { createSiteBotHandler, type SiteBotHandler, type SiteBotHandlerOptions } from './handler.js'

/**
 * `@sitebot/server/next` — App Router route handlers.
 *
 * ```ts
 * // app/api/chat/[[...route]]/route.ts
 * import { createRouteHandlers } from '@sitebot/server/next'
 * import { config } from '@/sitebot.config'
 *
 * export const { GET, POST, OPTIONS } = createRouteHandlers(config)
 * export const runtime = 'nodejs'
 * ```
 *
 * Next.js hands route handlers a real `Request` and expects a real `Response`,
 * so this adapter is a rename. It exists so that a Next.js developer does not
 * have to know that, and so that the catch-all segment (which is what makes
 * `/config`, `/feedback` and `/health` reachable) is documented somewhere they
 * will look.
 */
export interface NextRouteHandlers {
  GET: (request: Request) => Promise<Response>
  POST: (request: Request) => Promise<Response>
  OPTIONS: (request: Request) => Promise<Response>
  handler: SiteBotHandler
}

export function createRouteHandlers(
  config: ResolvedConfig,
  options: SiteBotHandlerOptions = {},
): NextRouteHandlers {
  const safe = createSafeFetch()
  const handler = createSiteBotHandler(config, {
    ...options,
    deps: {
      fetchImpl: safe.fetch,
      resolveHost: safe.resolveHost,
      connectStdioMcp,
      ...options.deps,
    },
  })
  return {
    GET: handler,
    POST: handler,
    OPTIONS: handler,
    handler,
  }
}
