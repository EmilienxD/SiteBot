import type { ComponentChildren } from 'preact'
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])
export function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((block, index) => (
        <p key={index}>{inline(block)}</p>
      ))}
    </>
  )
}
function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = []
  const pattern = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*|\*([^*]+)\*)/g
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
    else if (match[5]) out.push(<strong>{match[5]}</strong>)
    else if (match[6]) out.push(<em>{match[6]}</em>)
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
