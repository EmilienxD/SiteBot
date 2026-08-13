import type { PublicConfig } from '@sitebot/config'
import type { PageContext, WidgetController } from './types.js'

export type ClientToolHandler = (input: unknown) => unknown | Promise<unknown>

export interface ClientToolOptions {
  config: PublicConfig
  pageContext: () => Promise<PageContext | null>
  registered: Map<string, ClientToolHandler>
}

export async function runClientTool(
  name: string,
  input: unknown,
  options: ClientToolOptions,
): Promise<unknown> {
  if (!options.config.capabilities.clientTools.includes(name))
    throw new Error(`Client tool "${name}" is not allowed by the server.`)
  const result = options.registered.has(name)
    ? await options.registered.get(name)?.(input)
    : await builtinClientTool(name, input, options)
  return capResult(result)
}

async function builtinClientTool(
  name: string,
  input: unknown,
  options: ClientToolOptions,
): Promise<unknown> {
  const value = asRecord(input)
  switch (name) {
    case 'highlight': {
      const element = query(value.selector)
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (element instanceof HTMLElement) {
        element.style.outline = '3px solid #f59e0b'
        setTimeout(() => {
          element.style.outline = ''
        }, 1800)
      }
      return { found: element !== null }
    }
    case 'navigate': {
      const path = typeof value.path === 'string' ? value.path : ''
      if (!isAllowedPath(path, options.config)) throw new Error('Navigation target is not allowed.')
      history.pushState({}, '', path)
      return { navigated: true, path }
    }
    case 'fill_form': {
      const form = query(value.selector)
      if (!(form instanceof HTMLFormElement)) return { filled: false, reason: 'form_not_found' }
      const fields = asRecord(value.fields)
      for (const [name, fieldValue] of Object.entries(fields)) {
        const control = form.elements.namedItem(name)
        if (
          control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement ||
          control instanceof HTMLSelectElement
        ) {
          control.value = String(fieldValue ?? '')
          control.dispatchEvent(new Event('input', { bubbles: true }))
          control.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }
      return { filled: true }
    }
    case 'read_element': {
      const selector = typeof value.selector === 'string' ? value.selector : ''
      const element = query(selector)
      if (
        element !== null &&
        options.config.ui.pageContext.readSelectorDenylist.some((pattern) =>
          matchesElement(element, pattern),
        )
      )
        return { error: 'selector_denied' }
      return { found: element !== null, text: element?.textContent?.slice(0, 8000) ?? '' }
    }
    case 'get_page_context':
      return options.pageContext()
    case 'open_url': {
      const url = typeof value.url === 'string' ? value.url : ''
      const parsed = new URL(url, location.href)
      if (parsed.origin !== location.origin && !/^https?:$/.test(parsed.protocol))
        throw new Error('URL is not allowed.')
      window.open(parsed.href, '_blank', 'noopener,noreferrer')
      return { opened: true, url: parsed.href }
    }
    case 'copy_to_clipboard': {
      const text = typeof value.text === 'string' ? value.text : ''
      await navigator.clipboard.writeText(text)
      return { copied: true }
    }
    default:
      throw new Error(`No client tool handler registered for "${name}".`)
  }
}

function query(selector: unknown): Element | null {
  if (typeof selector !== 'string' || selector === '') return null
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}
function matchesElement(element: Element, selector: string): boolean {
  try {
    return element.matches(selector) || element.closest(selector) !== null
  } catch {
    return false
  }
}
function safeMatches(value: string, pattern: string): boolean {
  try {
    return (
      value === pattern ||
      new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(
        value,
      )
    )
  } catch {
    return false
  }
}
function isAllowedPath(path: string, config: PublicConfig): boolean {
  if (!path.startsWith('/')) return false
  const routes = [...config.capabilities.routes, ...config.ui.behaviour.navigateAllowlist]
  return path === '/' || routes.some((pattern) => safeMatches(path, pattern))
}
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function capResult(value: unknown): unknown {
  const encoded = JSON.stringify(value)
  return encoded.length <= 16_384 ? value : { error: 'result_too_large' }
}

export function registerClientTool(
  registered: Map<string, ClientToolHandler>,
  name: string,
  handler: ClientToolHandler,
): void {
  registered.set(name, handler)
}
export function unregisterClientTool(
  registered: Map<string, ClientToolHandler>,
  name: string,
): void {
  registered.delete(name)
}

export type { WidgetController }
