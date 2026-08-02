/**
 * @sitebot/server — layer 3.
 *
 * Adapters only. Each one normalises its framework's request into a Web
 * `Request`, calls `engine.handleChat`, and translates the `Response` back.
 * All the logic lives in @sitebot/core; nothing here should be more than thin.
 *
 * Implemented in Phase 3 — see docs/03-protocol.md.
 *
 * Every framework adapter has its own subpath, so importing
 * `@sitebot/server/next` never pulls in Express, Fastify or Hono:
 *
 *   @sitebot/server/fetch     → (req: Request) => Promise<Response>   // Workers, Deno, Bun
 *   @sitebot/server/next      → { GET, POST, OPTIONS } route handlers
 *   @sitebot/server/express   → middleware
 *   @sitebot/server/fastify   → a Fastify plugin
 *   @sitebot/server/hono      → Hono middleware
 *   @sitebot/server/node      → (req: IncomingMessage, res: ServerResponse) => void
 *
 * This root entry carries the shared pieces and the standalone server.
 */

export { createSiteBotHandler, DEFAULT_BASE_PATH, resolveRoute, ROUTES } from './handler.js'
export type {
  Feedback,
  RequestInfo,
  RouteName,
  SiteBotHandler,
  SiteBotHandlerOptions,
} from './handler.js'

export { createFetchHandler } from './fetch.js'
export { createServer } from './server.js'
export type { CreateServerOptions, SiteBotServer } from './server.js'

export {
  ALLOWED_REQUEST_HEADERS,
  corsHeaders,
  PREFLIGHT_MAX_AGE_SECONDS,
  preflightResponse,
} from './http/cors.js'
export { extractToken, readBodyWithLimit, resolveClientIp, resolveLocale } from './http/context.js'
