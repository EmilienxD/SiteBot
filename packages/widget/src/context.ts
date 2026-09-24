import type { Ui } from '@sitebot/config'
import { matchesAny } from './paths.js'
import type { PageContext } from './types.js'

export { matchesAny }

const REMOVE = 'script,style,noscript,nav,footer,aside,svg,[aria-hidden="true"],site-chat'

export async function extractPageContext(
  ui: Ui,
  previousHash?: string,
  custom?: Record<string, unknown>,
): Promise<PageContext | null> {
  if (matchesAny(location.pathname, ui.pageContext.excludePaths)) return null
  const root = document.querySelector(ui.extract.selector) ?? document.body
  const clone = root.cloneNode(true) as HTMLElement
  for (const selector of [REMOVE, ...ui.extract.strip, ...ui.pageContext.redactSelectors]) {
    try {
      clone.querySelectorAll(selector).forEach((node) => node.remove())
    } catch {
      /* invalid selector */
    }
  }
  // Forms go last but are reserved room, so truncation never cuts them off.
  const forms = describeForms(clone)
  const text = truncate(toStructuredText(clone), 4000 - (forms ? forms.length + 1 : 0))
  const extract = forms ? `${text}\n${forms}` : text
  const hash = await hashText(extract)
  const meta: Record<string, string> = {}
  document.querySelectorAll<HTMLMetaElement>('meta[property^="og:"]').forEach((node) => {
    const name = node.getAttribute('property')
    if (name && node.content) meta[name] = node.content
  })
  return {
    url: location.href,
    path: location.pathname,
    title: document.title,
    description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '',
    locale: document.documentElement.lang || navigator.language,
    referrer: document.referrer,
    selection: window.getSelection()?.toString().trim().slice(0, 1000) || null,
    ...(hash === previousHash ? { extractHash: hash } : { extract, extractHash: hash }),
    meta,
    custom,
  }
}

function toStructuredText(root: HTMLElement): string {
  const lines: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent?.replace(/\s+/g, ' ').trim()
      if (value) lines.push(value)
    } else if (node instanceof HTMLElement && /^H[1-6]$/.test(node.tagName))
      lines.push(`${'#'.repeat(Number(node.tagName[1]))} `)
    else if (node instanceof HTMLElement && node.tagName === 'LI') lines.push('• ')
  }
  return lines
    .join(' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
/**
 * A compact outline of the page's forms — field names, types and the options
 * of each select or radio group, never current values — so the model can
 * call `fill_form` with values the form accepts instead of guessing.
 */
function describeForms(root: HTMLElement): string {
  const out: string[] = []
  for (const form of [...root.querySelectorAll('form')].slice(0, 5)) {
    // Only a selector `fill_form` can use verbatim is worth describing.
    const formName = form.getAttribute('name') ?? ''
    const selector = /^[A-Za-z][\w-]*$/.test(form.id)
      ? `#${form.id}`
      : /^[\w-]+$/.test(formName)
        ? `form[name="${formName}"]`
        : null
    if (selector === null) continue
    const fields: string[] = []
    const seen = new Set<string>()
    for (const control of form.querySelectorAll<HTMLElement>('input,select,textarea')) {
      const name = control.getAttribute('name')
      if (!name || seen.has(name) || fields.length >= 20) continue
      seen.add(name)
      if (control instanceof HTMLSelectElement) {
        const options = [...control.options]
          .filter((option) => option.value !== '')
          .slice(0, 20)
          .map((option) => choice(option.value, option.textContent ?? ''))
        fields.push(`${name} (select: ${options.join(' | ')})`)
      } else if (control instanceof HTMLTextAreaElement) fields.push(`${name} (textarea)`)
      else if (control instanceof HTMLInputElement) {
        if (['hidden', 'password', 'file', 'submit', 'button', 'reset'].includes(control.type))
          continue
        if (control.type === 'radio') {
          const options = [...form.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
            .filter((radio) => radio.name === name)
            .slice(0, 20)
            .map((radio) => choice(radio.value, radio.closest('label')?.textContent ?? ''))
          fields.push(`${name} (radio: ${options.join(' | ')})`)
        } else fields.push(`${name} (${control.type})`)
      }
    }
    if (fields.length > 0) out.push(`[Form ${selector}: ${fields.join(', ')}]`)
  }
  return out.join('\n').slice(0, 1200)
}
function choice(value: string, label: string): string {
  const text = label.replace(/\s+/g, ' ').trim()
  return text && text !== value ? `${value} "${text}"` : value
}
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const slice = text.slice(0, limit - 13)
  const boundary = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  )
  return `${slice.slice(0, boundary > limit * 0.7 ? boundary + 1 : slice.length)}…[truncated]`
}
async function hashText(text: string): Promise<string> {
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(16)
}
