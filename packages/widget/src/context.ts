import type { Ui } from '@sitebot/config'
import type { PageContext } from './types.js'

const REMOVE = 'script,style,noscript,nav,footer,aside,svg,[aria-hidden="true"],site-chat'

export async function extractPageContext(ui: Ui, previousHash?: string): Promise<PageContext | null> {
  if (matchesAny(location.pathname, ui.pageContext.excludePaths)) return null
  const root = document.querySelector(ui.extract.selector) ?? document.body
  const clone = root.cloneNode(true) as HTMLElement
  for (const selector of [REMOVE, ...ui.extract.strip, ...ui.pageContext.redactSelectors]) {
    try { clone.querySelectorAll(selector).forEach((node) => node.remove()) } catch { /* invalid selector */ }
  }
  const extract = truncate(toStructuredText(clone), 4000)
  const hash = await hashText(extract)
  const meta: Record<string, string> = {}
  document.querySelectorAll<HTMLMetaElement>('meta[property^="og:"]').forEach((node) => { const name = node.getAttribute('property'); if (name && node.content) meta[name] = node.content })
  return { url: location.href, path: location.pathname, title: document.title, description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '', locale: document.documentElement.lang || navigator.language, referrer: document.referrer, selection: window.getSelection()?.toString().trim().slice(0, 1000) || null, ...(hash === previousHash ? { extractHash: hash } : { extract, extractHash: hash }), meta }
}

export function matchesAny(path: string, patterns: readonly string[]): boolean { return patterns.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(path)) }
function toStructuredText(root: HTMLElement): string { const lines: string[] = []; const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); let node: Node | null; while ((node = walker.nextNode())) { if (node.nodeType === Node.TEXT_NODE) { const value = node.textContent?.replace(/\s+/g, ' ').trim(); if (value) lines.push(value) } else if (node instanceof HTMLElement && /^H[1-6]$/.test(node.tagName)) lines.push(`${'#'.repeat(Number(node.tagName[1]))} `); else if (node instanceof HTMLElement && node.tagName === 'LI') lines.push('• ') } return lines.join(' ').replace(/\s+([.,!?;:])/g, '$1').replace(/\s+/g, ' ').trim() }
function truncate(text: string, limit: number): string { if (text.length <= limit) return text; const slice = text.slice(0, limit - 13); const boundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? ')); return `${slice.slice(0, boundary > limit * 0.7 ? boundary + 1 : slice.length)}…[truncated]` }
async function hashText(text: string): Promise<string> { if (crypto.subtle) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') } let hash = 2166136261; for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0).toString(16) }
