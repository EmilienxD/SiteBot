import type { ResolvedConfig } from '@sitebot/config'
import { createSiteBotHandler, type SiteBotHandler, type SiteBotHandlerOptions } from './handler.js'
import { withNodeRuntime } from './node-runtime.js'

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
  const handler = createSiteBotHandler(config, withNodeRuntime(config, options))
  // NextRequest.url normalizes 127.0.0.1/::1 to localhost. A standard Request
  // copy retains the original internal URL, body and linked abort signal, so
  // same-origin CORS compares the browser's actual origin without trusting a
  // forwarded Host header or treating distinct loopback origins as equivalent.
  const route = (request: Request) => handler(new Request(request))
  return {
    GET: route,
    POST: route,
    OPTIONS: route,
    handler,
  }
}
