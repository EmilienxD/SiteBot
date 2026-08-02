/**
 * Draft a `siteContext` block from the site's homepage.
 *
 * Layer 1 of the knowledge stack is the one that makes a first run impressive
 * (docs/06-knowledge.md §1), and it is also the one a developer is least likely
 * to fill in by hand. So `init` fetches the homepage once and writes a draft:
 * company, description, and the nav structure as `routes`.
 *
 * The output is explicitly a *draft*. Every field is scaffolded with a comment
 * telling the developer to check it, because a `<title>` is a marketing string
 * and a nav is not always the site's real information architecture.
 *
 * Parsing is regex-based rather than a DOM. That is normally the wrong call,
 * but here the input is one page, the fields wanted are four, and the failure
 * mode is a slightly worse draft that a human is going to edit anyway — none of
 * which justifies a parser dependency in the package people run with `npx`.
 */

export interface SiteDraft {
  company?: string
  description?: string
  primaryUrl: string
  routes: { path: string; summary?: string }[]
}

export interface DraftOptions {
  timeoutMs?: number
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Cap on the bytes read, so a huge page cannot stall `init`. */
  maxBytes?: number
}

export class SiteDraftError extends Error {
  readonly fix: string
  constructor(message: string, fix: string) {
    super(message)
    this.name = 'SiteDraftError'
    this.fix = fix
  }
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 2_000_000

export async function draftSiteContext(
  siteUrl: string,
  options: DraftOptions = {},
): Promise<SiteDraft> {
  const url = normaliseUrl(siteUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let html: string
  try {
    const response = await fetchImpl(url.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'sitebot-init' },
    })
    if (!response.ok) {
      throw new SiteDraftError(
        `${url.href} responded ${response.status}.`,
        'Check the URL, or skip the draft and fill in siteContext by hand.',
      )
    }
    html = truncate(await response.text(), options.maxBytes ?? DEFAULT_MAX_BYTES)
  } catch (cause) {
    if (cause instanceof SiteDraftError) throw cause
    const reason = controller.signal.aborted ? 'timed out' : describe(cause)
    throw new SiteDraftError(
      `Could not fetch ${url.href}: ${reason}.`,
      'Skip the draft and fill in siteContext by hand, or re-run init when the site is reachable.',
    )
  } finally {
    clearTimeout(timeout)
  }

  return extractDraft(html, url)
}

/** Exported for tests: the parsing half, with no network involved. */
export function extractDraft(html: string, url: URL): SiteDraft {
  const head = html.slice(0, 200_000)

  const company =
    meta(head, 'og:site_name') ??
    trimTitle(tag(head, 'title')) ??
    capitalise(url.hostname.replace(/^www\./, '').split('.')[0] ?? '')

  const description =
    meta(head, 'description') ?? meta(head, 'og:description') ?? tag(head, 'h1') ?? undefined

  return {
    ...(company === '' ? {} : { company }),
    ...(description === undefined ? {} : { description: collapse(description) }),
    primaryUrl: url.origin,
    routes: extractRoutes(html, url),
  }
}

/**
 * Same-origin links from the page's navigation, in document order.
 *
 * `routes` doubles as the allowlist for the builtin `navigate` client tool
 * (docs/02 §6), so a link that does not belong in the draft is a link the
 * assistant must not be able to send a visitor to. That is the reason for
 * preferring `<nav>`/`<header>` over every anchor on the page: a footer full of
 * legal pages and social links would pad the allowlist with noise.
 */
function extractRoutes(html: string, url: URL): { path: string; summary?: string }[] {
  const navs = [...html.matchAll(/<(nav|header)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2] ?? '')
  const scope = navs.length > 0 ? navs.join('\n') : html

  const seen = new Map<string, string>()
  for (const match of scope.matchAll(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href = '', inner = ''] = match
    const path = samePath(href, url)
    if (path === null || seen.has(path)) continue

    const label = collapse(stripTags(inner))
    if (label === '' || label.length > 60) continue
    seen.set(path, label)
    if (seen.size >= 12) break
  }

  return [...seen].map(([path, label]) => ({ path, summary: label }))
}

/** A same-origin, non-asset path, normalised. Anything else returns null. */
function samePath(href: string, base: URL): string | null {
  if (href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return null

  let resolved: URL
  try {
    resolved = new URL(href, base)
  } catch {
    return null
  }
  if (resolved.origin !== base.origin) return null
  if (/\.(png|jpe?g|svg|gif|webp|ico|pdf|zip|css|js|xml|json)$/i.test(resolved.pathname)) return null

  const path = resolved.pathname.replace(/\/+$/, '')
  return path === '' ? null : path
}

function normaliseUrl(input: string): URL {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`
  try {
    return new URL(withScheme)
  } catch {
    throw new SiteDraftError(
      `"${input}" is not a valid URL.`,
      'Pass the site origin, for example https://acme.com.',
    )
  }
}

function tag(html: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(html)
  const value = match?.[1]
  return value === undefined ? undefined : collapse(stripTags(decode(value)))
}

function meta(html: string, name: string): string | undefined {
  // Attribute order varies, so match the tag then pick `content` out of it.
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const raw = match[0]
    const key = /(?:name|property)=["']([^"']+)["']/i.exec(raw)?.[1]
    if (key?.toLowerCase() !== name.toLowerCase()) continue
    const content = /content=["']([^"']*)["']/i.exec(raw)?.[1]
    if (content !== undefined && content.trim() !== '') return collapse(decode(content))
  }
  return undefined
}

/** `Acme — Freight for importers` → `Acme`. Titles are usually `brand | tagline`. */
function trimTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined
  const [first] = title.split(/\s+[|·—–-]\s+/)
  const candidate = (first ?? title).trim()
  return candidate === '' ? undefined : candidate
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

function decode(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    '#39': "'",
    apos: "'",
    nbsp: ' ',
  }
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    const key = entity.toLowerCase()
    if (named[key] !== undefined) return named[key]
    if (key.startsWith('#x')) return codePoint(parseInt(key.slice(2), 16), whole)
    if (key.startsWith('#')) return codePoint(parseInt(key.slice(1), 10), whole)
    return whole
  })
}

function codePoint(value: number, fallback: string): string {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : fallback
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function capitalise(value: string): string {
  return value === '' ? '' : value[0]?.toUpperCase() + value.slice(1)
}

function truncate(value: string, maxBytes: number): string {
  return value.length > maxBytes ? value.slice(0, maxBytes) : value
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
