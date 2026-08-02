import { EngineError } from '../stream/errors.js'

/**
 * Origin allowlist — docs/08-security.md §7.
 *
 * `security.allowedOrigins` defaults to empty, which means **same-origin only**.
 * There is no wildcard default and `*` alone is rejected at config validation,
 * so a cross-origin sidecar has to name its origins. That is the single most
 * load-bearing default in this file: a template deployed by copy-paste should
 * not be callable from anywhere on the internet.
 */

/** Lowercased `scheme://host[:port]`, or null when the header is absent/garbage. */
export function normaliseOrigin(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  // Browsers send the literal string "null" for opaque origins (sandboxed
  // iframes, file://, some redirects). It is never a legitimate allowlist entry.
  if (trimmed === '' || trimmed === 'null') return null
  try {
    const url = new URL(trimmed)
    return url.origin.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Exact match, or a single-level wildcard in the host position
 * (`https://*.acme.com` matches `https://app.acme.com`, not `https://a.b.acme.com`
 * and not `https://acme.com`).
 *
 * Multi-level matching is deliberately absent: `https://*.acme.com` covering
 * `evil.attacker.acme.com` is fine, but the same pattern written against a
 * provider domain would cover every tenant on that provider. One level is the
 * most that is safe to offer without the developer thinking about it.
 */
export function matchesOrigin(origin: string, pattern: string): boolean {
  const target = origin.toLowerCase()
  const rule = pattern.trim().toLowerCase()

  if (!rule.includes('*')) return normaliseOrigin(rule) === target

  const starIndex = rule.indexOf('*')
  // Only a leading `*.` in the host is supported; anything else is not a
  // pattern we promised to honour, so it matches nothing rather than
  // approximately something.
  const schemeEnd = rule.indexOf('://')
  if (schemeEnd === -1 || starIndex !== schemeEnd + 3) return false
  if (!rule.startsWith('*.', schemeEnd + 3)) return false

  const scheme = rule.slice(0, schemeEnd)
  const suffix = rule.slice(schemeEnd + 5) // past `://*.`
  if (suffix === '' || suffix.includes('*')) return false

  let host: string
  try {
    const url = new URL(target)
    if (`${url.protocol.slice(0, -1)}` !== scheme) return false
    host = url.host
  } catch {
    return false
  }

  if (!host.endsWith(`.${suffix}`)) return false
  const label = host.slice(0, host.length - suffix.length - 1)
  return label !== '' && !label.includes('.')
}

export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.some((pattern) => matchesOrigin(origin, pattern))
}

export interface OriginCheckInput {
  /** The `Origin` header, verbatim. */
  origin: string | null | undefined
  allowedOrigins: readonly string[]
  /** This deployment's own origin, from the request URL. */
  selfOrigin?: string | null
}

/**
 * Decide whether a request may proceed, and what to echo back in
 * `Access-Control-Allow-Origin`.
 *
 * A missing `Origin` header is allowed: `curl`, server-to-server callers and
 * same-origin navigations in older browsers all omit it, and CORS is not a
 * server-side authorisation mechanism in the first place. What it is not
 * allowed to do is unlock a *cross*-origin browser request, because the browser
 * would have sent the header.
 */
export function checkOrigin(input: OriginCheckInput): { allowOrigin: string | null } {
  const origin = normaliseOrigin(input.origin)
  if (origin === null) return { allowOrigin: null }

  const self = normaliseOrigin(input.selfOrigin)
  if (self !== null && origin === self) return { allowOrigin: origin }

  if (!isOriginAllowed(origin, input.allowedOrigins)) {
    throw new EngineError('origin_denied', {
      detail: `origin ${origin} is not in security.allowedOrigins`,
    })
  }

  return { allowOrigin: origin }
}
