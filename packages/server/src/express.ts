import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from '@sitebot/config'
import { connectStdioMcp, createSafeFetch } from '@sitebot/core/node'
import { createSiteBotHandler, type SiteBotHandler, type SiteBotHandlerOptions } from './handler.js'
import { sendWebResponse, socketIp, toWebRequest } from './http/node-bridge.js'

/**
 * `@sitebot/server/express` — middleware.
 *
 * ```ts
 * app.use('/api/chat', createExpressMiddleware(config))
 * ```
 *
 * Two Express-specific hazards, both handled here:
 *
 *  1. **Mount-relative URLs.** Under `app.use('/api/chat')`, `req.url` is
 *     `/config`, not `/api/chat/config`. `resolveRoute` accepts both shapes, so
 *     the mount path and `basePath` do not have to agree.
 *  2. **`express.json()`.** If a body parser ran first, `req` has already been
 *     consumed and streaming it again yields nothing. Mount this *before* any
 *     body parser, or scope the parser away from this path — the check below
 *     turns the silent hang that would otherwise result into a clear error.
 */

// Structural, so this file does not import Express and pull it into the bundle.
export interface ExpressRequest extends IncomingMessage {
  body?: unknown
  ip?: string
}
export type ExpressResponse = ServerResponse
export type ExpressNext = (error?: unknown) => void

export interface ExpressMiddleware {
  (request: ExpressRequest, response: ExpressResponse, next: ExpressNext): void
  handler: SiteBotHandler
  dispose(): Promise<void>
}

export function createExpressMiddleware(
  config: ResolvedConfig,
  options: SiteBotHandlerOptions = {},
): ExpressMiddleware {
  const safe = createSafeFetch()
  const handler = createSiteBotHandler(config, { ...options, deps: { fetchImpl: safe.fetch, resolveHost: safe.resolveHost, connectStdioMcp, ...options.deps } })

  const middleware = function siteBotExpressMiddleware(
    request: ExpressRequest,
    response: ExpressResponse,
    next: ExpressNext,
  ): void {
    if (request.body !== undefined && request.method === 'POST') {
      next(
        new Error(
          'A body parser has already consumed this request. Mount the SiteBot middleware before express.json(), or exclude its path from the parser.',
        ),
      )
      return
    }

    void handler(toWebRequest(request), { clientIp: request.ip ?? socketIp(request) })
      .then((webResponse) => sendWebResponse(response, webResponse))
      .catch(next)
  } as ExpressMiddleware

  middleware.handler = handler
  middleware.dispose = handler.dispose
  return middleware
}
