/**
 * HTML → Markdown extraction — docs/06-knowledge.md §3.3.
 *
 * Server-side, dependency-free, deliberately heuristic. The pipeline runs at
 * build time on content the site owner controls; the bar is "good enough to
 * retrieve against," not perfect rendering fidelity. Sites that need exact
 * extraction set `extract.selector` and `extract.strip`, which are honoured
 * first (the explicit override), and only then fall back to the
 * readability-style main-content heuristic.
 *
 * A selector subset is supported: tag, `.class`, `#id`, `[attr="value"]`, and
 * comma-separated groups — the same subset the widget's page-context
 * extraction accepts, so a developer can tune selectors in the browser and
 * expect the same hits server-side.
 */

export interface ExtractOptions {
  /** Explicit main-content override, e.g. `main, article, [role="main"]`. */
  selector?: string
  /** Elements removed before extraction, e.g. `nav, footer, .cookie-banner`. */
  strip?: string[]
  format?: 'markdown' | 'text'
  /** Pages shorter than this after extraction are skipped. */
  minChars?: number
}

export interface ExtractedPage {
  title: string
  text: string
  /** Heading outline seen during extraction — used by the chunker. */
  headings: { level: number; text: string; offset: number }[]
  skipped: boolean
}

interface Element {
  tag: string
  attrs: Record<string, string>
  children: Node[]
}

type Node = Element | string

const VOID_TAGS = new Set([
  'br',
  'img',
  'hr',
  'input',
  'meta',
  'link',
  'area',
  'base',
  'col',
  'embed',
  'source',
  'track',
  'wbr',
])
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'canvas',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'noscript',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
  'video',
])

/** Minimal permissive HTML parser. Tolerates unclosed tags and bare text. */
export function parseHtml(html: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] }
  const stack: Element[] = [root]

  let index = 0
  const length = html.length
  while (index < length) {
    const lt = html.indexOf('<', index)
    if (lt < 0) {
      pushText(stack, html.slice(index))
      break
    }
    pushText(stack, html.slice(index, lt))

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      index = end < 0 ? length : end + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt)
      index = end < 0 ? length : end + 1
      continue
    }

    const closing = html[lt + 1] === '/'
    const gt = findTagEnd(html, lt + 1)
    if (gt < 0) {
      pushText(stack, html.slice(lt))
      break
    }
    const raw = html.slice(lt + 1, gt)
    index = gt + 1

    if (closing) {
      const name = raw.slice(1).trim().toLowerCase().split(/\s+/)[0] ?? ''
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth]?.tag === name) {
          stack.length = depth
          break
        }
      }
      continue
    }

    const match = /^([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>'"])*)\/?$/.exec(raw)
    if (match === null) continue
    const tag = (match[1] ?? '').toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'textarea') {
      const closeTag = `</${tag}>`
      const end = html.toLowerCase().indexOf(closeTag, index)
      index = end < 0 ? length : end + closeTag.length
      continue
    }
    const attrs = parseAttrs(match[2] ?? '')
    if (VOID_TAGS.has(tag) || raw.endsWith('/')) {
      stack.at(-1)?.children.push({ tag, attrs, children: [] })
      continue
    }
    const element: Element = { tag, attrs, children: [] }
    stack.at(-1)?.children.push(element)
    stack.push(element)
  }
  return root
}

function findTagEnd(html: string, start: number): number {
  let quote: string | null = null
  for (let index = start; index < html.length; index++) {
    const char = html[index]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    if (char === '>') return index
  }
  return -1
}

function parseAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match
  while ((match = pattern.exec(input)) !== null) {
    attrs[match[1]!.toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? ''
  }
  return attrs
}

function pushText(stack: Element[], text: string): void {
  if (text === '') return
  stack.at(-1)?.children.push(text)
}

function decodeEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&nbsp;', ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
}

// ── selector subset ─────────────────────────────────────────────────────────

interface SimpleSelector {
  tag?: string
  id?: string
  classes: string[]
  attrs: [string, string?][]
}

function parseSelector(input: string): SimpleSelector[][] {
  return input.split(',').map((group) =>
    group
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => {
        const selector: SimpleSelector = { classes: [], attrs: [] }
        const pattern = /(^[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']([^"']*)["'])?\]/g
        let match
        while ((match = pattern.exec(part)) !== null) {
          if (match[1] !== undefined) selector.tag = match[1].toLowerCase()
          else if (match[2] !== undefined) selector.id = match[2]
          else if (match[3] !== undefined) selector.classes.push(match[3])
          else if (match[4] !== undefined) selector.attrs.push([match[4], match[5]])
        }
        return selector
      }),
  )
}

function matchesOne(element: Element, selector: SimpleSelector): boolean {
  if (selector.tag !== undefined && element.tag !== selector.tag) return false
  if (selector.id !== undefined && element.attrs['id'] !== selector.id) return false
  const classes = (element.attrs['class'] ?? '').split(/\s+/)
  for (const cls of selector.classes) if (!classes.includes(cls)) return false
  for (const [name, value] of selector.attrs) {
    if (!(name in element.attrs)) return false
    if (value !== undefined && element.attrs[name] !== value) return false
  }
  return true
}

function matchesChain(element: Element, ancestors: Element[], chain: SimpleSelector[]): boolean {
  if (!matchesOne(element, chain[chain.length - 1]!)) return false
  let search = ancestors.length - 1
  for (let depth = chain.length - 2; depth >= 0; depth--) {
    let found = false
    for (; search >= 0; search--) {
      if (matchesOne(ancestors[search]!, chain[depth]!)) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

/** Elements matching any comma-group of the selector subset, document order. */
export function querySelectorAll(
  root: Element,
  selector: string,
): { element: Element; ancestors: Element[] }[] {
  const groups = parseSelector(selector)
  const out: { element: Element; ancestors: Element[] }[] = []
  const walk = (node: Node, ancestors: Element[]): void => {
    if (typeof node === 'string') return
    const chain = [...ancestors, node]
    if (groups.some((group) => matchesChain(node, ancestors, group))) {
      out.push({ element: node, ancestors })
    }
    for (const child of node.children) walk(child, chain)
  }
  for (const child of root.children) walk(child, [])
  return out
}

function prune(target: Element, toRemove: Set<Element>): void {
  target.children = target.children.filter((child) => {
    if (typeof child === 'string') return true
    if (toRemove.has(child)) return false
    prune(child, toRemove)
    return true
  })
}

// ── the extractor ───────────────────────────────────────────────────────────

/**
 * Readability-style main-content heuristic: pick the element among the
 * `selector` matches (default `main, article, [role="main"]`) with the most
 * text; when none matches, use `<body>`. `strip` selectors are removed either
 * way, before rendering.
 */
export function extract(html: string, options: ExtractOptions = {}): ExtractedPage {
  const tree = parseHtml(html)

  const docTitle = textOf(findFirst(tree, 'title'))
  const h1Title = textOf(findFirst(tree, 'h1'))
  const title = docTitle.trim() !== '' ? docTitle.trim() : h1Title.trim()

  const stripGroups = options.strip ?? ['nav', 'footer', 'aside', '.cookie-banner']
  const toRemove = new Set<Element>()
  for (const selector of stripGroups) {
    for (const { element } of querySelectorAll(tree, selector)) toRemove.add(element)
  }
  if (toRemove.size > 0) prune(tree, toRemove)

  const mainSelector = options.selector ?? 'main, article, [role="main"]'
  const candidates = querySelectorAll(tree, mainSelector).map(({ element }) => element)
  let content: Element | undefined
  let bestScore = -1
  for (const candidate of candidates) {
    const score = textOf(candidate).trim().length
    if (score > bestScore) {
      bestScore = score
      content = candidate
    }
  }
  content ??= findFirst(tree, 'body') ?? tree

  const headings: { level: number; text: string; offset: number }[] = []
  const renderer = options.format === 'text' ? renderText : renderMarkdown
  const offsets: { collect(level: number, text: string): void } = {
    collect(level, text) {
      headings.push({ level, text, offset: 0 })
    },
  }
  const text = renderer(content, offsets)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Offsets are filled in by the renderer; recompute them after whitespace
  // collapsing so they point into the emitted text.
  recomputeOffsets(text, headings)

  return {
    title,
    text,
    headings,
    skipped: text.length < (options.minChars ?? 200),
  }
}

function findFirst(root: Element, tag: string): Element | undefined {
  for (const { element } of querySelectorAll(root, tag)) return element
  return undefined
}

function textOf(element: Element | undefined): string {
  if (element === undefined) return ''
  let out = ''
  const walk = (node: Node): void => {
    if (typeof node === 'string') out += node
    else for (const child of node.children) walk(child)
  }
  walk(element)
  return decodeEntities(out)
}

interface HeadingCollector {
  collect(level: number, text: string): void
}

function renderMarkdown(element: Element, headings: HeadingCollector): string {
  const parts: string[] = []
  const walk = (node: Node): void => {
    if (typeof node === 'string') {
      parts.push(decodeEntities(node.replace(/\s+/g, ' ')))
      return
    }
    const tag = node.tag
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1])
      const text = textOf(node).trim()
      if (text !== '') {
        headings.collect(level, text)
        parts.push('\n' + '#'.repeat(level) + ' ' + text + '\n')
      }
      return
    }
    if (tag === 'a') {
      const text = textOf(node).trim()
      const href = node.attrs['href']
      parts.push(
        href !== undefined &&
          text !== '' &&
          !href.startsWith('#') &&
          !href.startsWith('javascript:')
          ? `[${text}](${href})`
          : text,
      )
      return
    }
    if (tag === 'code' || tag === 'pre') {
      const text = textOf(node)
      parts.push(tag === 'pre' ? `\n\`\`\`\n${text.trim()}\n\`\`\`\n` : `\`${text}\``)
      return
    }
    if (tag === 'li') {
      parts.push('\n- ')
      node.children.forEach(walk)
      return
    }
    if (tag === 'blockquote') {
      const inner = node.children.map(walkCollect).join('').trim()
      parts.push(
        '\n' +
          inner
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n') +
          '\n',
      )
      return
    }
    if (BLOCK_TAGS.has(tag)) parts.push('\n\n')
    node.children.forEach(walk)
    if (BLOCK_TAGS.has(tag)) parts.push('\n\n')
  }
  const walkCollect = (node: Node): string => {
    if (typeof node === 'string') return decodeEntities(node)
    return node.children.map(walkCollect).join('')
  }
  walk(element)
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function renderText(element: Element, headings: HeadingCollector): string {
  const parts: string[] = []
  const walk = (node: Node): void => {
    if (typeof node === 'string') {
      parts.push(decodeEntities(node))
      return
    }
    if (/^h[1-6]$/.test(node.tag)) {
      headings.collect(Number(node.tag[1]), textOf(node).trim())
      parts.push('\n')
    }
    node.children.forEach(walk)
    if (BLOCK_TAGS.has(node.tag)) parts.push('\n')
  }
  walk(element)
  return parts
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function recomputeOffsets(
  text: string,
  headings: { level: number; text: string; offset: number }[],
): void {
  let cursor = 0
  for (const heading of headings) {
    const index = text.indexOf(heading.text, cursor)
    heading.offset = index < 0 ? cursor : index
    cursor = heading.offset + heading.text.length
  }
}
