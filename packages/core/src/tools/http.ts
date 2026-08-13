import type { RequestContext } from '../types.js'
import { EngineError } from '../stream/errors.js'
import type { JsonSchemaObject } from './schema.js'

export interface HttpExecutorConfig {
  method: string
  url: string
  headers: Record<string, string>
  query: Record<string, string>
  body?: unknown
  timeoutMs?: number
  responsePath?: string
  maxResponseBytes: number
  errorMap: Record<string, string>
  allowHosts?: string[]
  allowPrivateNetwork: boolean
  maxRedirects: number
}

export type HostResolver = (hostname: string) => Promise<string[]>

export function createHttpExecutor(
  config: HttpExecutorConfig,
  fetchImpl = globalThis.fetch,
  resolveHost?: HostResolver,
) {
  if (fetchImpl === undefined)
    throw new EngineError('not_ready', { message: 'HTTP tools require fetch.' })
  validateTemplate(config)
  return async (input: Record<string, unknown>, ctx: RequestContext): Promise<unknown> => {
    const origin = new URL(config.url)
    const hosts = new Set((config.allowHosts ?? [origin.hostname]).map(normalizeHost))
    let url = await assertUrl(
      render(config.url, input, ctx, true),
      hosts,
      config.allowPrivateNetwork,
      resolveHost,
    )
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(config.query))
      params.set(key, render(value, input, ctx, false))
    url.search = params.toString()
    const headers = new Headers()
    for (const [key, value] of Object.entries(config.headers))
      headers.set(key, render(value, input, ctx, false))
    const body =
      config.body === undefined
        ? ['POST', 'PUT', 'PATCH'].includes(config.method)
          ? JSON.stringify(input)
          : undefined
        : JSON.stringify(renderValue(config.body, input, ctx))
    if (body !== undefined && !headers.has('content-type'))
      headers.set('content-type', 'application/json')

    for (let redirects = 0; ; redirects += 1) {
      const controller = new AbortController()
      const abort = () => controller.abort(ctx.signal.reason)
      ctx.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000)
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: config.method,
          headers,
          body,
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch (error) {
        throw new EngineError('internal_error', {
          message: config.errorMap.network ?? 'The tool could not complete.',
          cause: error,
        })
      } finally {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', abort)
      }
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location !== null) {
        if (redirects >= config.maxRedirects) return { error: 'redirect_limit_reached' }
        url = await assertUrl(
          new URL(location, url),
          hosts,
          config.allowPrivateNetwork,
          resolveHost,
        )
        continue
      }
      const text = await readLimited(response, config.maxResponseBytes)
      if (!response.ok)
        return {
          error: 'http_error',
          status: response.status,
          message:
            config.errorMap[String(response.status)] ??
            `The tool returned HTTP ${response.status}.`,
        }
      if (text === '') return null
      const contentType = response.headers.get('content-type') ?? ''
      if (/^(image|audio|video|application\/octet-stream)/i.test(contentType))
        return { error: 'unsupported_content_type' }
      if (!contentType.includes('json')) return text
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        return text
      }
      return config.responsePath === undefined ? value : getPath(value, config.responsePath)
    }
  }
}

function validateTemplate(config: HttpExecutorConfig): void {
  const authority = config.url.match(/^[a-z]+:\/\/([^/]+)/i)?.[1] ?? ''
  if (/[{][^}]+[}]/.test(authority))
    throw new EngineError('not_ready', {
      message: 'Model-controlled parameters may not appear in an HTTP host.',
    })
  for (const value of Object.values(config.headers))
    if (/[{][^}]+[}]/.test(value) && !/{{(?:identity|session|page)\.[^}]+}}/.test(value))
      throw new EngineError('not_ready', {
        message: 'Model-controlled parameters are forbidden in HTTP headers.',
      })
}

function render(
  template: string,
  input: Record<string, unknown>,
  ctx: RequestContext,
  encodeParameters: boolean,
): string {
  return template.replace(
    /{{\s*([^}]+)\s*}}|{([^}]+)}/g,
    (_match, trusted: string | undefined, parameter: string | undefined) => {
      const value =
        trusted === undefined ? lookup(input, parameter as string) : lookupContext(ctx, trusted)
      const text = value == null ? '' : String(value)
      if (trusted === undefined && encodeParameters && unsafeParameter(text))
        throw new EngineError('internal_error', {
          message: 'The tool parameter contains an unsafe URL value.',
        })
      return trusted === undefined && encodeParameters ? encodeURIComponent(text) : text
    },
  )
}

function renderValue(value: unknown, input: Record<string, unknown>, ctx: RequestContext): unknown {
  if (typeof value === 'string') return render(value, input, ctx, false)
  if (Array.isArray(value)) return value.map((item) => renderValue(item, input, ctx))
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, input, ctx)]),
    )
  return value
}

function lookup(value: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    )
}
function lookupContext(ctx: RequestContext, path: string): unknown {
  const [root, ...rest] = path.split('.')
  const value =
    root === 'identity'
      ? ctx.identity
      : root === 'session'
        ? { id: ctx.sessionId }
        : root === 'page'
          ? ctx.pageContext
          : undefined
  return rest.reduce<unknown>(
    (current, key) =>
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  )
}
function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/\.$/, '')
}
async function assertUrl(
  value: string | URL,
  hosts: Set<string>,
  allowPrivate: boolean,
  resolveHost?: HostResolver,
): Promise<URL> {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new EngineError('internal_error', { message: 'The tool URL must use HTTP or HTTPS.' })
  if (!hosts.has(normalizeHost(url.hostname)))
    throw new EngineError('internal_error', { message: 'The tool URL host is not allowed.' })
  if (!allowPrivate) {
    if (privateHost(url.hostname))
      throw new EngineError('internal_error', {
        message: 'The tool cannot access private network addresses.',
      })
    if (resolveHost !== undefined) {
      const addresses = await resolveHost(url.hostname)
      if (addresses.length === 0 || addresses.some(privateHost))
        throw new EngineError('internal_error', {
          message: 'The tool host resolved to a private network address.',
        })
    }
  }
  return url
}
function privateHost(hostname: string): boolean {
  const host = normalizeHost(hostname).replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '::' ||
    host === '0.0.0.0' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  )
    return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  const a = parts[0] ?? -1
  const b = parts[1] ?? -1
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}
function unsafeParameter(value: string): boolean {
  return (
    value.includes('..') ||
    value.includes('\\') ||
    value.startsWith('@') ||
    /^(?:localhost|127\.0\.0\.1|169\.254\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/i.test(
      value,
    )
  )
}
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    const remaining = maxBytes - total
    if (remaining <= 0) break
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value
    chunks.push(chunk)
    total += chunk.byteLength
    if (total >= maxBytes) break
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(result)
  return total >= maxBytes ? `${text}\n...[truncated]` : text
}
function getPath(value: unknown, path: string): unknown {
  return path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    )
}

export type { JsonSchemaObject }
