import type { ResolvedConfig } from '@sitebot/config'
import { checkOrigin, EngineError } from '@sitebot/core'

/**
 * CORS — docs/08-security.md §7.
 *
 * Four rules from that section, all of them enforced here:
 *
 *  1. `allowedOrigins` defaults to empty, meaning same-origin only. There is no
 *     wildcard default, and `*` alone is rejected at config validation.
 *  2. `Access-Control-Allow-Credentials` is **never** sent. We do not use
 *     cookies, and sending it would forbid the wildcard-free echo below from
 *     ever being safely relaxed later.
 *  3. Preflight is cached for 24 hours.
 *  4. The `Origin` header is checked on the actual request too, not just on the
 *     preflight — a preflight-only check is no check at all, since a `POST`
 *     with a simple content type never triggers one.
 */

export const PREFLIGHT_MAX_AGE_SECONDS = 86_400

export const ALLOWED_REQUEST_HEADERS = [
  'content-type',
  'x-sitebot-key',
  'authorization',
  'x-sitebot-session',
]

export interface CorsInput {
  config: ResolvedConfig
  origin: string | null
  /** This deployment's own origin, from the request URL. */
  selfOrigin: string | null
}

/**
 * Headers to attach to a real (non-preflight) response.
 *
 * `Vary: Origin` is not optional: without it a CDN can cache the response for
 * one origin and serve it to another, which turns a correct allowlist into an
 * incorrect one at the edge.
 */
export function corsHeaders(input: CorsInput): Record<string, string> {
  const { allowOrigin } = checkOrigin({
    origin: input.origin,
    allowedOrigins: input.config.security.allowedOrigins,
    selfOrigin: input.selfOrigin,
  })

  if (allowOrigin === null) return { vary: 'Origin' }
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-expose-headers': 'x-sitebot-request-id',
    vary: 'Origin',
  }
}

/**
 * Answer an `OPTIONS` preflight.
 *
 * A denied origin gets a 403 rather than a 204 without the allow header. Both
 * fail the browser's check, but only one of them shows up legibly in a
 * developer's network tab when they have forgotten to list their origin — which
 * is by far the most common way this goes wrong.
 */
export function preflightResponse(input: CorsInput): Response {
  let headers: Record<string, string>
  try {
    headers = corsHeaders(input)
  } catch (error) {
    if (error instanceof EngineError) {
      return new Response(null, { status: 403, headers: { vary: 'Origin' } })
    }
    throw error
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': ALLOWED_REQUEST_HEADERS.join(', '),
      'access-control-max-age': String(PREFLIGHT_MAX_AGE_SECONDS),
    },
  })
}

/** Copy `headers` onto an existing response without rebuilding its body. */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value)
  }
  return response
}
