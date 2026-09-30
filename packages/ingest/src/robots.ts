import { DEFAULT_UA, fetchPage, type HttpFetchOptions } from './http.js'

interface Rule {
  allow: boolean
  path: string
}
interface Group {
  agents: string[]
  rules: Rule[]
}

/** RFC 9309: compare encoded UTF-8 octets, decoding only unreserved escapes. */
function octets(value: string): string {
  return value.replace(/[\u0080-\u{10ffff}]|%[0-9a-f]{2}/giu, (part) => {
    if (!part.startsWith('%')) return encodeURIComponent(part)
    const decoded = String.fromCharCode(parseInt(part.slice(1), 16))
    return /^[a-z0-9._~-]$/i.test(decoded) ? decoded : part.toUpperCase()
  })
}

export function robotsAllows(text: string, url: string, userAgent = DEFAULT_UA): boolean {
  const groups: Group[] = []
  let group: Group | undefined
  let hasRules = false
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line.split('#')[0] ?? '')
    if (match === null) continue
    const key = match[1]!.toLowerCase()
    const value = match[2]!
    if (key === 'user-agent') {
      if (group === undefined || hasRules) {
        group = { agents: [], rules: [] }
        groups.push(group)
        hasRules = false
      }
      group.agents.push(value.toLowerCase())
    } else if (group !== undefined) {
      hasRules = true
      if ((key === 'allow' || key === 'disallow') && value.startsWith('/')) {
        group.rules.push({ allow: key === 'allow', path: octets(value) })
      }
    }
  }
  const product = userAgent.split(/[\s/]/)[0]!.toLowerCase()
  const specificity = (g: Group): number =>
    Math.max(
      -1,
      ...g.agents.map((a) => (a === '*' ? 0 : a !== '' && product.includes(a) ? a.length : -1)),
    )
  const best = Math.max(-1, ...groups.map(specificity))
  const target = new URL(url)
  const path = octets(target.pathname + target.search)
  let winner: Rule | undefined
  let length = -1
  for (const g of groups) {
    if (best < 0 || specificity(g) !== best) continue
    for (const rule of g.rules) {
      const anchored = rule.path.endsWith('$')
      const raw = anchored ? rule.path.slice(0, -1) : rule.path
      const pattern = raw
        .split('*')
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')
      const size = raw.replaceAll('*', '').replace(/%[0-9A-F]{2}/g, 'x').length
      if (
        new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path) &&
        (size > length || (size === length && rule.allow))
      ) {
        winner = rule
        length = size
      }
    }
  }
  return winner?.allow ?? true
}

/** One robots request per origin per run. Unavailable rules abort the run. */
export function robotsPolicy(options: HttpFetchOptions): (url: string) => Promise<boolean> {
  const cache = new Map<string, Promise<string>>()
  return async (url) => {
    const origin = new URL(url).origin
    let pending = cache.get(origin)
    if (pending === undefined) {
      pending = fetchPage(`${origin}/robots.txt`, { ...options, allowed: undefined }).then(
        (page) => {
          if (page.status === 429 || page.status >= 500) {
            throw new Error(
              `robots.txt unavailable (${page.status}) at ${origin}; ingestion stopped`,
            )
          }
          return page.status >= 400 ? '' : page.body
        },
      )
      cache.set(origin, pending)
    }
    return robotsAllows(await pending, url, options.userAgent)
  }
}
