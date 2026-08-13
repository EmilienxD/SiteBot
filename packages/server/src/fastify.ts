import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from '@sitebot/config'
import { connectStdioMcp, createSafeFetch } from '@sitebot/core/node'
import { createSiteBotHandler, type SiteBotHandler, type SiteBotHandlerOptions } from './handler.js'
import { sendWebResponse, socketIp, toWebRequest } from './http/node-bridge.js'

/**
 * `@sitebot/server/fastify` — a plugin.
 *
 * ```ts
 * await app.register(sitebotPlugin(config), { prefix: '/api/chat' })
 * ```
 *
 * Fastify parses `application/json` bodies by default, which would consume the
 * request before we could stream it. The plugin therefore installs a
 * pass-through content-type parser **scoped to its own encapsulation context** —
 * registering it globally would break the host application's other routes,
 * which is why this is a plugin rather than a hook the developer wires up.
 */

// Structural types: this file must not import Fastify.
export interface FastifyLikeRequest {
  raw: IncomingMessage
  ip?: string
}
export interface FastifyLikeReply {
  raw: ServerResponse
  hijack?(): void
}
export interface FastifyLikeInstance {
  removeAllContentTypeParsers(): void
  addContentTypeParser(
    contentType: string | string[] | RegExp,
    options: { parseAs?: 'string' | 'buffer' } | ((...args: never[]) => unknown),
    parser?: (...args: never[]) => unknown,
  ): void
  all(path: string, handler: (request: never, reply: never) => Promise<void>): void
  addHook(name: string, hook: (...args: never[]) => Promise<void> | void): void
}

export interface FastifyPlugin {
  (instance: FastifyLikeInstance, opts: unknown): Promise<void>
  handler: SiteBotHandler
  dispose(): Promise<void>
}

export function createFastifyPlugin(
  config: ResolvedConfig,
  options: SiteBotHandlerOptions = {},
): FastifyPlugin {
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

  const plugin = async function siteBotFastifyPlugin(
    instance: FastifyLikeInstance,
    _opts: unknown,
  ): Promise<void> {
    // Fastify parses `application/json` by default, and a `'*'` parser does
    // not override it — a catch-all only covers content types nothing else
    // claims. Left in place, the default parser consumes the request before the
    // route handler runs, and the already-drained socket then never produces an
    // end event for us to see. So the defaults are cleared first, inside this
    // plugin's encapsulation context, and everything is passed through raw.
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser('*', {}, ((
      _request: unknown,
      payload: unknown,
      done: (error: Error | null, body?: unknown) => void,
    ) => {
      done(null, payload)
    }) as never)

    const route = async (request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<void> => {
      // Hand the socket to us: Fastify must not try to serialise a reply it
      // does not own, and an SSE body is written chunk by chunk.
      reply.hijack?.()
      const response = await handler(toWebRequest(request.raw), {
        clientIp: request.ip ?? socketIp(request.raw),
      })
      await sendWebResponse(reply.raw, response)
    }

    instance.all('/', route as never)
    instance.all('/*', route as never)
  } as FastifyPlugin

  plugin.handler = handler
  plugin.dispose = handler.dispose

  // Fastify reads this to decide whether to encapsulate the plugin. We *want*
  // encapsulation here, so the content-type parser above stays scoped — hence
  // no `fastify-plugin` wrapper.
  return plugin
}
