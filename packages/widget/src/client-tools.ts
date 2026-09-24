import type { PublicConfig } from '@sitebot/config'
import type { PageContext, WidgetController } from './types.js'

export type ClientToolHandler = (input: unknown) => unknown | Promise<unknown>

export interface ClientToolOptions {
  config: PublicConfig
  pageContext: () => Promise<PageContext | null>
  registered: Map<string, ClientToolHandler>
  /**
   * Performs a same-tab navigation. The controller defers it until the run
   * has finished — navigating at once would unload the page before the tool
   * result reached the server. Defaults to `location.assign`.
   */
  navigate?: (path: string) => void
}

export async function runClientTool(
  name: string,
  input: unknown,
  options: ClientToolOptions,
): Promise<unknown> {
  if (!options.config.capabilities.clientTools.includes(name))
    throw new Error(`Client tool "${name}" is not allowed by the server.`)
  // The allowlist is by tool name; the implementation is by executor id.
  const id = options.config.capabilities.clientToolIds?.[name] ?? name
  const registered = options.registered.get(name) ?? options.registered.get(id)
  const result = registered ? await registered(input) : await builtinClientTool(id, input, options)
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
      // A real navigation, not `history.pushState`: on a multi-page site a
      // pushed URL changes the address bar and nothing else. SPAs register
      // their router instead — `SiteBot.registerTool('navigate', router.push)`
      // — and a registered handler always wins over this builtin.
      ;(options.navigate ?? ((target: string) => location.assign(target)))(path)
      return { navigated: true, path }
    }
    case 'fill_form':
      return fillForm(value)
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

interface FieldRejection {
  field: string
  reason: 'invalid_option' | 'invalid_value' | 'read_only' | 'unsupported'
  options?: { value: string; label: string }[]
}

/**
 * Sets each named field, then reads it back: a `<select>` given a value that
 * is none of its options silently ends up with nothing chosen, and the model
 * must not tell the visitor a form is filled when it isn't. Never submits.
 */
function fillForm(value: Record<string, unknown>): unknown {
  const form = query(value.selector)
  if (!(form instanceof HTMLFormElement)) return { filled: false, reason: 'form_not_found' }
  const filledFields: string[] = []
  const rejected: FieldRejection[] = []
  const missing: string[] = []
  for (const [name, fieldValue] of Object.entries(asRecord(value.fields))) {
    const control = form.elements.namedItem(name)
    const requested = fieldValue === null || fieldValue === undefined ? '' : String(fieldValue)
    const outcome = control === null ? 'missing' : setControl(control, requested, fieldValue)
    if (outcome === 'missing') missing.push(name)
    else if (outcome === true) filledFields.push(name)
    else rejected.push({ field: name, ...outcome })
  }
  return {
    filled: filledFields.length > 0 && rejected.length === 0 && missing.length === 0,
    filledFields,
    rejected,
    missing,
  }
}

function setControl(
  control: Element | RadioNodeList,
  requested: string,
  raw: unknown,
): true | Omit<FieldRejection, 'field'> {
  if (control instanceof RadioNodeList) {
    const radios = [...control].filter(
      (node): node is HTMLInputElement => node instanceof HTMLInputElement && node.type === 'radio',
    )
    if (radios.length === 0) return { reason: 'unsupported' }
    const choices = radios.map((radio) => ({ value: radio.value, label: labelOf(radio) }))
    const index = matchChoice(choices, requested)
    const radio = index === -1 ? undefined : radios[index]
    if (radio === undefined) return { reason: 'invalid_option', options: choices }
    if (radio.disabled) return { reason: 'read_only' }
    radio.checked = true
    notify(radio)
    return true
  }
  if (control instanceof HTMLSelectElement) {
    if (control.disabled) return { reason: 'read_only' }
    const options = [...control.options].filter((option) => !option.disabled)
    const choices = options.map((option) => ({ value: option.value, label: optionLabel(option) }))
    const index = matchChoice(choices, requested)
    const option = index === -1 ? undefined : options[index]
    if (option === undefined)
      return {
        reason: 'invalid_option',
        options: choices.filter((choice) => choice.value !== '').slice(0, 50),
      }
    control.value = option.value
    notify(control)
    return control.value === option.value ? true : { reason: 'invalid_value' }
  }
  if (control instanceof HTMLInputElement) {
    if (control.disabled || control.readOnly) return { reason: 'read_only' }
    // Hidden fields carry server state (prices, ids) the visitor never sees.
    if (control.type === 'hidden' || control.type === 'file') return { reason: 'unsupported' }
    if (control.type === 'checkbox' || control.type === 'radio') {
      control.checked = isTruthy(raw, control.value)
      notify(control)
      return true
    }
    control.value = requested
    notify(control)
    // Typed inputs (number, date, email…) sanitise a malformed value to ''.
    return control.value === requested ? true : { reason: 'invalid_value' }
  }
  if (control instanceof HTMLTextAreaElement) {
    if (control.disabled || control.readOnly) return { reason: 'read_only' }
    control.value = requested
    notify(control)
    return true
  }
  return { reason: 'unsupported' }
}

/** Exact value, then exact label, then a loose match ("5 – 20 kg" ≈ "5-20kg"). */
function matchChoice(choices: { value: string; label: string }[], requested: string): number {
  const loose = normalizeChoice(requested)
  const finders: ((choice: { value: string; label: string }) => boolean)[] = [
    (choice) => choice.value === requested,
    (choice) => choice.label === requested,
    (choice) => normalizeChoice(choice.value) === loose,
    (choice) => normalizeChoice(choice.label) === loose,
  ]
  for (const find of finders) {
    const index = choices.findIndex(find)
    if (index !== -1) return index
  }
  return -1
}
function normalizeChoice(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, '')
}
function optionLabel(option: HTMLOptionElement): string {
  return (option.label || option.textContent || '').trim()
}
function labelOf(input: HTMLInputElement): string {
  return [...(input.labels ?? [])]
    .map((label) => label.textContent ?? '')
    .join(' ')
    .trim()
}
function isTruthy(raw: unknown, controlValue: string): boolean {
  if (typeof raw === 'boolean') return raw
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
  const accepted = ['true', 'yes', 'on', '1', 'checked']
  if (controlValue !== '') accepted.push(controlValue.toLowerCase())
  return accepted.includes(text)
}
function notify(control: HTMLElement): void {
  control.dispatchEvent(new Event('input', { bubbles: true }))
  control.dispatchEvent(new Event('change', { bubbles: true }))
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
