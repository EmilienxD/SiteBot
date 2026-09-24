import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from '@sitebot/config'
import { createSiteBotHandler, type SiteBotHandler, type SiteBotHandlerOptions } from './handler.js'
import { withNodeRuntime } from './node-runtime.js'
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
  const handler = createSiteBotHandler(config, withNodeRuntime(config, options))

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

export { lazySessionStore, withNodeRuntime } from './node-runtime.js'
