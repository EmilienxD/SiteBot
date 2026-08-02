import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from '@sitebot/config'
import { connectStdioMcp, createRedisRateLimitStore, createSafeFetch } from '@sitebot/core/node'
import { createSiteBotHandler, type SiteBotHandler, type SiteBotHandlerOptions } from './handler.js'
import { sendWebResponse, socketIp, toWebRequest } from './http/node-bridge.js'

/**
 * `@sitebot/server/node` — a bare `http.createServer` listener.
 *
 * ```ts
 * const sitebot = createNodeHandler(config)
 * http.createServer((req, res) => {
 *   if (req.url?.startsWith('/api/chat')) return sitebot(req, res)
 *   // …your own routes
 * }).listen(3000)
 * ```
 */
export interface NodeHandler {
  (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void>
  handler: SiteBotHandler
  dispose(): Promise<void>
}

export function createNodeHandler(
  config: ResolvedConfig,
  options: SiteBotHandlerOptions = {},
): NodeHandler {
  const safe = createSafeFetch()
  const rateLimitStore =
    options.rateLimitStore ??
    (config.security.rateLimit.store === 'redis'
      ? createRedisRateLimitStore({ url: resolveRedisUrl(config) })
      : undefined)
  const handler = createSiteBotHandler(config, {
    ...options,
    ...(rateLimitStore === undefined ? {} : { rateLimitStore }),
    deps: {
      fetchImpl: safe.fetch,
      resolveHost: safe.resolveHost,
      connectStdioMcp,
      ...options.deps,
    },
  })

  const listener = async function siteBotNodeHandler(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> {
    const response = await handler(toWebRequest(incoming), { clientIp: socketIp(incoming) })
    await sendWebResponse(outgoing, response)
  } as NodeHandler

  listener.handler = handler
  listener.dispose = handler.dispose
  return listener
}

function resolveRedisUrl(config: ResolvedConfig): string {
  const configured =
    config.security.rateLimit.url ??
    (config.storage.type === 'redis' ? config.storage.url : undefined)
  const value = configured ?? process.env.SITEBOT_REDIS_URL
  if (value === undefined || value === '') {
    throw new Error(
      'security.rateLimit.store is redis but no URL is configured; set security.rateLimit.url, storage.url, or SITEBOT_REDIS_URL',
    )
  }
  return value
}
