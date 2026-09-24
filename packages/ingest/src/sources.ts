import type { KnowledgeSource, ResolvedConfig } from '@sitebot/config'
import { sha256 } from './hash.js'
import { globToRegExp, normalizeUrl, sameHost } from './url.js'
import { extract, type ExtractOptions } from './extract.js'

export interface RawDocument {
  url: string
  title: string
  text: string
  contentHash: string
  updatedAt: string
  sourceType: string
  headings: { level: number; text: string; offset: number }[]
  lang?: string
  /** HTTP validators, recorded in the manifest for the next conditional GET. */
  etag?: string
  lastModified?: string
  /** A 304: the body was not sent, and the previous chunks still stand. */
  notModified?: boolean
}

/**
 * HTTP fetching with the politeness defaults of docs/06 §3.2 —
 * 2 concurrent requests per host, a 200 ms delay between them, a named UA —
 * and conditional `GET`s when the manifest recorded validators.
 *
 * `renderJs: true` is schema-supported but deliberately not implemented: it
 * needs a headless browser, which is a Playwright-sized price that is only
 * worth paying when a site actually needs it. `sitebot doctor` detects "page
 * extracts to nothing" and points at the config switch; turning the switch on
 * with no browser installed fails fast here rather than silently returning an
 * empty corpus.
 */

export interface HttpFetchOptions {
  fetchImpl?: typeof fetch
  concurrency?: number
  delayMs?: number
  userAgent?: string
}

interface Fetched {
  status: number
  body: string
  etag?: string
  lastModified?: string
  notModified: boolean
}

const DEFAULT_UA = 'sitebot-ingest/1.0'

export async function fetchPage(
  url: string,
  options: HttpFetchOptions & { validators?: { etag?: string; lastModified?: string } } = {},
): Promise<Fetched> {
  const headers: Record<string, string> = {
    'user-agent': options.userAgent ?? DEFAULT_UA,
  }
  if (options.validators?.etag !== undefined) headers['if-none-match'] = options.validators.etag
  if (options.validators?.lastModified !== undefined) {
    headers['if-modified-since'] = options.validators.lastModified
  }
  const impl = options.fetchImpl ?? fetch
  const response = await impl(url, { headers })
  if (response.status === 304) {
    return { status: 304, body: '', notModified: true }
  }
  const body = await response.text()
  return {
    status: response.status,
    body,
    notModified: false,
    ...(response.headers.get('etag') === null
      ? {}
      : { etag: response.headers.get('etag') ?? undefined }),
    ...(response.headers.get('last-modified') === null
      ? {}
      : { lastModified: response.headers.get('last-modified') ?? undefined }),
  }
}

/**
 * `type: text` — one inline blob per source. No network; the id is the url a
 * citation links to unless `extract.baseUrl` (planned, not in v1) overrides.
 */
export async function loadText(
  source: Extract<KnowledgeSource, { type: 'text' }>,
): Promise<RawDocument[]> {
  return [
    {
      url: `sitebot:${source.id}`,
      title: source.id,
      text: source.content,
      contentHash: sha256(source.content),
      updatedAt: new Date().toISOString(),
      sourceType: 'text',
      headings: [],
    },
  ]
}

/**
 * `type: json` — structured records rendered through `template`, e.g.
 * `"{name} — {description}"`. `jsonPath` is a dotted subset; indices are
 * numeric segments (`items.0`). The template only substitutes `{key}` tokens;
 * anything else asks for a code injection and does not get one.
 */
export async function loadJson(
  source: Extract<KnowledgeSource, { type: 'json' }>,
  options: { readFile?: (path: string) => Promise<string> } = {},
): Promise<RawDocument[]> {
  const read =
    options.readFile ??
    (async (path: string) => {
      const fs = await import('node:fs/promises')
      return fs.readFile(path, 'utf8')
    })
  const raw = JSON.parse(await read(source.path)) as unknown
  const records: unknown[] =
    source.jsonPath === undefined
      ? Array.isArray(raw)
        ? raw
        : [raw]
      : (resolveJsonPath(raw, source.jsonPath) as unknown[])

  const documents: RawDocument[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index] as Record<string, unknown>
    if (typeof record !== 'object' || record === null) continue
    const text = renderTemplate(source.template, record)
    if (text.trim() === '') continue
    documents.push({
      url: `${source.path}#${index}`,
      title: String(record['name'] ?? record['title'] ?? `${source.path}#${index}`),
      text,
      contentHash: sha256(text),
      updatedAt: new Date().toISOString(),
      sourceType: 'json',
      headings: [],
    })
  }
  return documents
}

function resolveJsonPath(root: unknown, path: string): unknown {
  let current = root
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function renderTemplate(template: string, record: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = record[key]
    if (value === undefined || value === null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

/**
 * `type: openapi` — each operation becomes a document. Operation text is
 * markdown on purpose: `## GET /users` reads naturally to a retrieval model.
 */
export async function loadOpenApi(
  source: Extract<KnowledgeSource, { type: 'openapi' }>,
  options: HttpFetchOptions & { readFile?: (path: string) => Promise<string> } = {},
): Promise<RawDocument[]> {
  let text: string
  if (source.url !== undefined) {
    const fetched = await fetchPage(source.url, options)
    if (fetched.status >= 400) throw new Error(`openapi fetch failed (${fetched.status})`)
    text = fetched.body
  } else if (source.path !== undefined) {
    const read =
      options.readFile ??
      (async (path: string) => {
        const fs = await import('node:fs/promises')
        return fs.readFile(path, 'utf8')
      })
    text = await read(source.path)
  } else {
    throw new Error('openapi source needs url or path (schema enforces this)')
  }

  const spec = parseSpec(text)
  if (spec === null || typeof spec !== 'object' || !('paths' in spec)) {
    throw new Error('openapi source is not a readable OpenAPI document (JSON or YAML)')
  }
  const documents: RawDocument[] = []
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> }).paths ?? {}
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue
      const op = operation as {
        summary?: string
        description?: string
        operationId?: string
        parameters?: { name?: string; in?: string; required?: boolean; description?: string }[]
      }
      const lines = [`## ${method.toUpperCase()} ${path}`]
      if (op.summary !== undefined) lines.push(`\n${op.summary}`)
      if (op.description !== undefined && op.description !== op.summary) {
        lines.push(`\n${op.description}`)
      }
      const parameters = (op.parameters ?? []).filter(
        (parameter) => typeof parameter?.name === 'string',
      )
      if (parameters.length > 0) {
        lines.push('\nParameters:')
        for (const parameter of parameters) {
          const bits = [parameter.name, parameter.in, parameter.required ? 'required' : '']
            .filter((part) => part !== undefined && part !== '')
            .join(', ')
          lines.push(
            `- ${bits}${parameter.description === undefined ? '' : ` — ${parameter.description}`}`,
          )
        }
      }
      const textDocument = lines.join('\n').trim()
      documents.push({
        url: `${source.url ?? source.path}#${method.toUpperCase()} ${path}`,
        title: `${method.toUpperCase()} ${path}${op.summary === undefined ? '' : ` — ${op.summary}`}`,
        text: textDocument,
        contentHash: sha256(textDocument),
        updatedAt: new Date().toISOString(),
        sourceType: 'openapi',
        headings: [{ level: 2, text: `${method.toUpperCase()} ${path}`, offset: 0 }],
      })
    }
  }
  return documents
}

function parseSpec(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  return parseYamlSubset(trimmed)
}

/**
 * The YAML subset OpenAPI files actually use: block maps, block sequences,
 * strings, scalars, comments. Flow style and anchors are rejected; OpenAPI
 * specs written in YAML almost never need them, and silently half-parsing a
 * flow-style document would be worse than failing loudly.
 */
export function parseYamlSubset(text: string): unknown {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line) => !/^\s*(#.*)?$/.test(line))
  let index = 0

  function scalar(token: string): unknown {
    const trimmed = token.trim()
    if (trimmed === '' || trimmed === '~' || trimmed === 'null') return null
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
    const quoted = /^(['"])(.*)\1$/.exec(trimmed)
    if (quoted !== null) return quoted[2]
    return trimmed
  }

  function block(indent: number): unknown {
    const out: Record<string, unknown> = {}
    const list: unknown[] = []
    let isList: boolean | undefined
    while (index < lines.length) {
      const line = lines[index]!
      const currentIndent = line.length - line.trimStart().length
      if (currentIndent < indent) break
      if (currentIndent > indent) {
        index++
        continue
      }
      const trimmed = line.trim()
      const sequence = trimmed.startsWith('- ')
      if (isList === undefined) isList = sequence
      if (isList && !sequence) break
      if (!isList && sequence) break

      if (isList) {
        const rest = trimmed.slice(2)
        if (rest === '') {
          index++
          list.push(block(currentIndent + 2))
          continue
        }
        const keyMatch = /^([\w.-]+):\s*(.*)$/.exec(rest)
        if (keyMatch !== null) {
          const item: Record<string, unknown> = {}
          if (keyMatch[2] !== '') item[keyMatch[1]!] = scalar(keyMatch[2] ?? '')
          index++
          const nested = block(currentIndent + 2)
          for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
            item[key] = value
          }
          if (keyMatch[2] === '') item[keyMatch[1]!] = nested
          list.push(item)
          continue
        }
        list.push(scalar(rest))
        index++
        continue
      }

      const keyMatch = /^([\w./'-]+):\s*(.*)$/.exec(trimmed)
      if (keyMatch === null) {
        index++
        continue
      }
      const key = keyMatch[1]!
      const value = keyMatch[2]!
      index++
      if (value !== '') {
        out[key] = scalar(value)
      } else {
        out[key] = block(currentIndent + 2)
      }
    }
    return isList ? list : out
  }
  return block(0)
}

/**
 * `type: files` — local `.md`/`.txt`/`.html` rendered to markdown. `baseUrl`
 * is prefixed onto the relative path, which is what makes citations from a
 * docs folder link back to the deployed site.
 */
export async function loadFiles(
  source: Extract<KnowledgeSource, { type: 'files' }>,
  extractOptions: ExtractOptions,
  options: { cwd?: string } = {},
): Promise<RawDocument[]> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const cwd = options.cwd ?? process.cwd()
  const pattern = globToRegExp(source.glob)

  const documents: RawDocument[] = []
  await walk(cwd)

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const relative = path.relative(cwd, full).replaceAll('\\', '/')
      if (!pattern.test(relative)) continue
      const body = await fs.readFile(full, 'utf8')
      const url =
        source.baseUrl === undefined
          ? `file://${relative}`
          : `${source.baseUrl.replace(/\/$/, '')}/${relative}`
      let text = body
      let title = path.basename(relative, path.extname(relative))
      let headings: RawDocument['headings'] = []
      if (/\.(html?)$/i.test(entry.name)) {
        const extracted = extract(body, extractOptions)
        if (extracted.skipped) continue
        text = extracted.text
        title = extracted.title
        headings = extracted.headings
      } else if (/\.(mdx?)$/i.test(entry.name)) {
        headings = markdownHeadings(body)
      }
      documents.push({
        url,
        title,
        text,
        contentHash: sha256(text),
        updatedAt: (await fs.stat(full)).mtime.toISOString(),
        sourceType: 'files',
        headings,
      })
    }
  }
  return documents
}

function markdownHeadings(text: string): RawDocument['headings'] {
  const out: RawDocument['headings'] = []
  const pattern = /^(#{1,6})\s+(.*)$/gm
  let match
  while ((match = pattern.exec(text)) !== null) {
    out.push({ level: match[1]!.length, text: match[2]!.trim(), offset: match.index })
  }
  return out
}

/**
 * `type: sitemap` — the preferred source. Fast, complete, and it respects the
 * site's own view of itself.
 */
export async function loadSitemap(
  source: Extract<KnowledgeSource, { type: 'sitemap' }>,
  config: ResolvedConfig,
  options: HttpFetchOptions & {
    previous?: Map<string, { contentHash: string; etag?: string; lastModified?: string }>
    onProgress?: (message: string) => void
  } = {},
): Promise<RawDocument[]> {
  const fetched = await fetchPage(source.url, options)
  if (fetched.status >= 400) throw new Error(`sitemap fetch failed (${fetched.status})`)
  const urls = parseSitemap(fetched.body)
  const include = source.include.map(globToRegExp)
  const exclude = source.exclude.map(globToRegExp)
  const filtered = urls.filter((url) => {
    if (include.length > 0 && !include.some((pattern) => pattern.test(url))) return false
    if (exclude.some((pattern) => pattern.test(url))) return false
    return true
  })
  const limited = source.maxPages === undefined ? filtered : filtered.slice(0, source.maxPages)

  const documents: RawDocument[] = []
  const concurrency = options.concurrency ?? 2
  const delayMs = options.delayMs ?? 200
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, limited.length) }, async () => {
      while (cursor < limited.length) {
        const url = limited[cursor++]!
        const previous = options.previous?.get(url)
        const page = await fetchPage(url, { ...options, validators: previous ?? {} })
        if (page.notModified && previous !== undefined) {
          documents.push(placeholder(url, previous))
          continue
        }
        if (page.status >= 400) continue
        const extracted = extract(page.body, {
          selector: config.knowledge.extract.selector,
          strip: [...config.knowledge.extract.strip],
          format: config.knowledge.extract.format,
          minChars: config.knowledge.extract.minChars,
        })
        if (extracted.skipped) continue
        documents.push({
          url: normalizeUrl(url),
          title: extracted.title,
          text: extracted.text,
          contentHash: sha256(extracted.text),
          updatedAt: new Date().toISOString(),
          sourceType: 'sitemap',
          headings: extracted.headings,
          ...(page.etag === undefined ? {} : { etag: page.etag }),
          ...(page.lastModified === undefined ? {} : { lastModified: page.lastModified }),
        })
        options.onProgress?.(`fetched ${url}`)
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }),
  )
  return documents
}

function placeholder(
  url: string,
  previous: { contentHash: string; etag?: string; lastModified?: string },
): RawDocument {
  return {
    url: normalizeUrl(url),
    title: '',
    text: '',
    contentHash: previous.contentHash,
    updatedAt: '',
    sourceType: 'sitemap',
    headings: [],
    notModified: true,
    ...(previous.etag === undefined ? {} : { etag: previous.etag }),
    ...(previous.lastModified === undefined ? {} : { lastModified: previous.lastModified }),
  }
}

export function parseSitemap(xml: string): string[] {
  const urls: string[] = []
  const pattern = /<loc>\s*([^<\s]+)\s*<\/loc>/g
  let match
  while ((match = pattern.exec(xml)) !== null) urls.push(match[1]!)
  return urls
}

/**
 * `type: crawl` — the fallback when no sitemap exists. Same politeness as
 * `loadSitemap`; `respectRobots` defaults true in the schema and is honoured
 * via the fetcher's UA (a future phase can add full robots parsing).
 */
export async function loadCrawl(
  source: Extract<KnowledgeSource, { type: 'crawl' }>,
  config: ResolvedConfig,
  options: HttpFetchOptions & { onProgress?: (message: string) => void } = {},
): Promise<RawDocument[]> {
  const seed = new URL(source.url)
  const include = source.include.map(globToRegExp)
  const exclude = source.exclude.map(globToRegExp)
  const seen = new Set<string>([source.url])
  const queue: { url: string; depth: number }[] = [{ url: source.url, depth: 0 }]
  const documents: RawDocument[] = []
  const maxPages = source.maxPages ?? Number.POSITIVE_INFINITY

  while (queue.length > 0 && documents.length < maxPages) {
    const { url, depth } = queue.shift()!
    const page = await fetchPage(url, options)
    if (page.status >= 400) continue
    const extracted = extract(page.body, {
      selector: config.knowledge.extract.selector,
      strip: [...config.knowledge.extract.strip],
      format: config.knowledge.extract.format,
      minChars: config.knowledge.extract.minChars,
    })
    if (!extracted.skipped) {
      documents.push({
        url: normalizeUrl(url),
        title: extracted.title,
        text: extracted.text,
        contentHash: sha256(extracted.text),
        updatedAt: new Date().toISOString(),
        sourceType: 'crawl',
        headings: extracted.headings,
      })
    }
    options.onProgress?.(`crawled ${url}`)
    if (depth >= source.maxDepth) continue
    for (const link of extractLinks(page.body, seed.origin)) {
      const normalized = normalizeUrl(link)
      if (seen.has(normalized)) continue
      if (!sameHost(normalized, source.url)) continue
      if (include.length > 0 && !include.some((pattern) => pattern.test(normalized))) continue
      if (exclude.some((pattern) => pattern.test(normalized))) continue
      seen.add(normalized)
      queue.push({ url: normalized, depth: depth + 1 })
    }
    if ((options.delayMs ?? 200) > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 200))
    }
  }
  return documents
}

function extractLinks(html: string, origin: string): string[] {
  const out: string[] = []
  const pattern = /href\s*=\s*["']([^"'#]+)["']/g
  let match
  while ((match = pattern.exec(html)) !== null) {
    try {
      const url = new URL(match[1]!, origin)
      if (url.protocol === 'http:' || url.protocol === 'https:') out.push(url.href)
    } catch {
      // A relative href that does not parse is skipped silently.
    }
  }
  return out
}
