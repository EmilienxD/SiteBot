/** Bounded, response-aware retries; redirects are checked before following them. */
export interface HttpFetchOptions {
  fetchImpl?: typeof fetch
  concurrency?: number
  delayMs?: number
  userAgent?: string
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
  /** Shared by a source's requests, including robots and browser navigation. */
  beforeRequest?: (url: string) => Promise<void>
  allowed?: (url: string) => Promise<boolean>
  withRequest?: <T>(url: string, action: () => Promise<T>) => Promise<T>
}

export interface Fetched {
  status: number
  body: string
  url: string
  etag?: string
  lastModified?: string
  notModified: boolean
  /** Decompressed response headers, including cookies needed by SPA APIs. */
  headers?: Record<string, string>
}

export const DEFAULT_UA = 'sitebot-ingest/1.0'
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function retryDelay(value: string | null, attempt: number, now = Date.now()): number {
  if (value !== null) {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000
    const date = Date.parse(value)
    if (Number.isFinite(date)) return Math.max(0, date - now)
  }
  return 1000 * 2 ** attempt
}

export async function fetchPage(
  url: string,
  options: HttpFetchOptions & { validators?: { etag?: string; lastModified?: string } } = {},
): Promise<Fetched> {
  const headers: Record<string, string> = { 'user-agent': options.userAgent ?? DEFAULT_UA }
  if (options.validators?.etag !== undefined) headers['if-none-match'] = options.validators.etag
  if (options.validators?.lastModified !== undefined) {
    headers['if-modified-since'] = options.validators.lastModified
  }
  const impl = options.fetchImpl ?? fetch
  let current = url
  for (let redirects = 0; redirects <= 10; redirects++) {
    if (options.allowed !== undefined && !(await options.allowed(current))) {
      return { status: 403, body: '', url: current, notModified: false }
    }
    let response: Response
    let body: string
    for (let attempt = 0; ; attempt++) {
      const request = async () => {
        await options.beforeRequest?.(current)
        const response = await impl(current, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        })
        return { response, body: await response.text() }
      }
      const result =
        options.withRequest === undefined
          ? await request()
          : await options.withRequest(current, request)
      response = result.response
      body = result.body
      if (![429, 503].includes(response.status) || attempt >= (options.maxRetries ?? 2)) break
      await (options.sleep ?? sleep)(retryDelay(response.headers.get('retry-after'), attempt))
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (location === null) throw new Error(`Redirect without Location: ${current}`)
      const next = new URL(location, current)
      if (!['http:', 'https:'].includes(next.protocol))
        throw new Error(`Unsupported redirect: ${next.href}`)
      if (next.origin !== new URL(current).origin) {
        delete headers['if-none-match']
        delete headers['if-modified-since']
      }
      current = next.href
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`HTTP fetch failed (${response.status}) at ${current}; ingestion stopped`)
    }
    return {
      status: response.status,
      body: response.status === 304 ? '' : body,
      url: current,
      notModified: response.status === 304,
      headers: Object.fromEntries([
        ...[...response.headers].filter(
          ([name]) =>
            !['content-length', 'content-encoding', 'transfer-encoding', 'set-cookie'].includes(
              name,
            ),
        ),
        ...(response.headers.getSetCookie().length === 0
          ? []
          : [['set-cookie', response.headers.getSetCookie().join('\n')]]),
      ]),
      ...(response.headers.get('etag') === null ? {} : { etag: response.headers.get('etag')! }),
      ...(response.headers.get('last-modified') === null
        ? {}
        : { lastModified: response.headers.get('last-modified')! }),
    }
  }
  throw new Error(`Too many redirects: ${url}`)
}

/** Limits active requests per origin, including browser resources. */
export function requestGate(concurrency = 2): NonNullable<HttpFetchOptions['withRequest']> {
  const hosts = new Map<string, { active: number; waiting: (() => void)[] }>()
  return async (url, action) => {
    const origin = new URL(url).origin
    let host = hosts.get(origin)
    if (host === undefined) {
      host = { active: 0, waiting: [] }
      hosts.set(origin, host)
    }
    if (host.active >= Math.max(1, concurrency)) {
      await new Promise<void>((resolve) => host!.waiting.push(resolve))
    } else {
      host.active++
    }
    try {
      return await action()
    } finally {
      const next = host.waiting.shift()
      if (next === undefined) host.active--
      else next()
    }
  }
}

/** Serializes request starts per origin, even for failures and skipped pages. */
export function requestScheduler(options: HttpFetchOptions): (url: string) => Promise<void> {
  const hosts = new Map<string, Promise<void>>()
  const nextStarts = new Map<string, number>()
  return async (url) => {
    const origin = new URL(url).origin
    const previous = hosts.get(origin) ?? Promise.resolve()
    const next = previous.then(async () => {
      const wait = Math.max(0, (nextStarts.get(origin) ?? 0) - Date.now())
      if (wait > 0) await (options.sleep ?? sleep)(wait)
      nextStarts.set(origin, Date.now() + (options.delayMs ?? 200))
      await options.beforeRequest?.(url)
    })
    hosts.set(
      origin,
      next.catch(() => {}),
    )
    await next
  }
}
