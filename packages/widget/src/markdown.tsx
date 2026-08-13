import { createElement, type ComponentChildren } from 'preact'

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** Small whitelist markdown renderer. Raw HTML is deliberately never emitted. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ComponentChildren[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const body: string[] = []
      index += 1
      while (index < lines.length && !lines[index]!.startsWith('```')) body.push(lines[index++]!)
      if (index < lines.length) index += 1
      blocks.push(
        <pre class="markdown-code" key={`code-${index}`}>
          <code data-language={language || undefined}>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      const match = /^(#{1,6})\s+(.*)$/.exec(line)!
      const level = match[1]!.length
      blocks.push(createElement(`h${level}`, { key: `heading-${index}` }, inline(match[2] ?? '')))
      index += 1
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        quote.push(lines[index]!.replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(<blockquote key={`quote-${index}`}>{inline(quote.join('\n'))}</blockquote>)
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ComponentChildren[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index]!)) {
        items.push(<li key={index}>{inline(lines[index]!.replace(/^\s*[-*+]\s+/, ''))}</li>)
        index += 1
      }
      blocks.push(<ul key={`ul-${index}`}>{items}</ul>)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ComponentChildren[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index]!)) {
        items.push(<li key={index}>{inline(lines[index]!.replace(/^\s*\d+[.)]\s+/, ''))}</li>)
        index += 1
      }
      blocks.push(<ol key={`ol-${index}`}>{items}</ol>)
      continue
    }
    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !lines[index]!.startsWith('```') &&
      !/^#{1,6}\s|^>\s?|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(lines[index]!)
    )
      paragraph.push(lines[index++]!)
    blocks.push(<p key={`p-${index}`}>{inline(paragraph.join('\n'))}</p>)
  }
  return <>{blocks}</>
}

function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = []
  const pattern =
    /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) out.push(text.slice(cursor, index))
    if (match[2] && match[3]) {
      const href = safeUrl(match[3])
      out.push(
        href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {match[2]}
          </a>
        ) : (
          match[2]
        ),
      )
    } else if (match[4]) out.push(<code>{match[4]}</code>)
    else if (match[5] || match[6]) out.push(<strong>{match[5] ?? match[6]}</strong>)
    else if (match[7] || match[8]) out.push(<em>{match[7] ?? match[8]}</em>)
    cursor = index + match[0].length
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value, location.href)
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}
