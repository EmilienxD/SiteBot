import type { ResolvedConfig } from '@sitebot/config'
import { createSiteBotHandler, type SiteBotHandler, type SiteBotHandlerOptions } from './handler.js'

/**
 * `@sitebot/server/hono` — middleware.
 *
 * ```ts
 * app.all('/api/chat/*', createHonoMiddleware(config))
 * ```
 *
 * Hono is already a `Request` → `Response` framework, so this is the thinnest
 * adapter of the six: it reads the request off the context and returns the
 * response. It exists for symmetry and for the typed signature, not because
 * there is anything to translate.
 */

// Structural, so Hono stays an optional peer dependency rather than a bundled
// one for the many deployments that never touch it.
export interface HonoLikeContext {
  req: { raw: Request }
  env?: unknown
}

export type HonoMiddleware = ((context: HonoLikeContext) => Promise<Response>) & {
  handler: SiteBotHandler
  dispose(): Promise<void>
}

export function createHonoMiddleware(
  config: ResolvedConfig,
  options: SiteBotHandlerOptions = {},
): HonoMiddleware {
  const handler = createSiteBotHandler(config, options)

  const middleware = (async (context: HonoLikeContext): Promise<Response> =>
    handler(context.req.raw)) as HonoMiddleware

  middleware.handler = handler
  middleware.dispose = handler.dispose
  return middleware
}
