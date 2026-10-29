import { resolveLocale as selectLocale, type LocaleConfig } from '@sitebot/config/i18n'
import type { Security } from '@sitebot/config'
import { EngineError } from '@sitebot/core'

/**
 * Turning a Web `Request` into the values `RequestContext` needs.
 *
 * Everything here is about *not* trusting the request more than it deserves —
 * headers a client can set (`X-Forwarded-For`, `Accept-Language`) versus values
 * the runtime can vouch for.
 */

const FORWARDED_FOR = 'x-forwarded-for'

/**
 * Resolve the client IP — docs/08-security.md §7.
 *
 * `X-Forwarded-For` is honoured **only** when `security.trustProxy` is set,
 * with a hop count. Blindly trusting it would make IP rate limits bypassable
 * with one header, and trusting only its first entry would too: the leftmost
 * value is the one the *client* wrote. Counting `hops` back from the right
 * skips the proxies we actually operate and lands on the address the outermost
 * trusted proxy observed.
 */
export function resolveClientIp(
  headers: Headers,
  trustProxy: Security['trustProxy'],
  socketIp?: string | null,
): string | null {
  if (trustProxy === false) return socketIp ?? null

  const forwarded = headers.get(FORWARDED_FOR)
  if (forwarded === null) return socketIp ?? null

  const chain = forwarded
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (chain.length === 0) return socketIp ?? null

  // hops = 1 means "one proxy in front of us", i.e. the last entry.
  const index = chain.length - trustProxy
  return chain[Math.max(0, index)] ?? socketIp ?? null
}

/** Body locale is authoritative; page context supports older clients. */
export function resolveLocale(
  headers: Headers,
  config: LocaleConfig | string,
  explicit?: string,
  pageLocale?: string,
): string {
  const browser = (headers.get('accept-language') ?? '')
    .split(',')
    .map((entry) => {
      const [tag, ...parameters] = entry.trim().split(';')
      const q = parameters.find((value) => value.trim().startsWith('q='))
      return { tag: tag?.trim() ?? '', quality: q === undefined ? 1 : Number(q.trim().slice(2)) }
    })
    .filter(({ quality }) => Number.isFinite(quality) && quality > 0 && quality <= 1)
    .sort((a, b) => b.quality - a.quality)
    .map(({ tag }) => tag)
  return selectLocale(typeof config === 'string' ? { locale: config } : config, {
    override: explicit,
    document: pageLocale,
    browser,
  })
}

/**
 * Read a body, refusing to buffer more than `maxBytes`.
 *
 * `Content-Length` is checked before this (it is free and catches the honest
 * case), but a chunked request has none and a lying one is trivial, so the cap
 * is enforced against the bytes actually read. This is the control that holds;
 * the header check is the one that is polite about it.
 */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  const body = request.body
  if (body === null) return ''

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new EngineError('payload_too_large', {
          detail: `body exceeded security.maxRequestBytes (${maxBytes})`,
        })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

export function parseJsonBody(text: string): unknown {
  if (text.trim() === '') {
    throw new EngineError('invalid_request', { detail: 'empty request body' })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new EngineError('invalid_request', { detail: 'body is not valid JSON', cause: error })
  }
}

/**
 * The bearer token, from either transport.
 *
 * The body's `auth` field is the documented path (docs/03 §2) because that is
 * what `SiteBot.identify()` populates; `Authorization` is accepted too so a
 * server-to-server caller does not have to reshape its request.
 */
export function extractToken(request: Request, bodyAuth?: string): string | null {
  if (typeof bodyAuth === 'string' && bodyAuth !== '') return bodyAuth
  const header = request.headers.get('authorization')
  if (header === null) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

/** A request id for correlating logs, telemetry and the response header. */
export function newRequestId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?(): string } }).crypto
  if (cryptoRef?.randomUUID !== undefined) return `req_${cryptoRef.randomUUID()}`
  return `req_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/** This deployment's own origin, for the same-origin CORS case. */
export function selfOriginOf(request: Request): string | null {
  try {
    return new URL(request.url).origin
  } catch {
    return null
  }
}
