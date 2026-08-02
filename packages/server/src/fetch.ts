import type { ResolvedConfig } from '@sitebot/config'
import { createSiteBotHandler, type SiteBotHandler, type SiteBotHandlerOptions } from './handler.js'

/**
 * `@sitebot/server/fetch` — the base every other adapter wraps.
 *
 * Cloudflare Workers, Deno, Bun and Vercel Edge all speak this directly:
 *
 * ```ts
 * export default { fetch: createFetchHandler(config) }
 * ```
 *
 * There is nothing to translate here, which is the point — the protocol is
 * implemented once, against the platform-neutral types, and every framework
 * adapter is measured by how little it adds to this.
 */
export function createFetchHandler(
  config: ResolvedConfig,
  options: SiteBotHandlerOptions = {},
): SiteBotHandler {
  return createSiteBotHandler(config, options)
}
