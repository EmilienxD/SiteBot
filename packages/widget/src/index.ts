import { ELEMENT_NAME, SiteChatElement, VERSION } from './element.js'
import type { SiteBotApi, SiteBotEvent, SiteBotOptions } from './types.js'

export { DEFAULT_Z_INDEX, ELEMENT_NAME, SiteChatElement, VERSION } from './element.js'
export { storageKey } from './storage.js'
export { matchesAny } from './paths.js'
export type {
  PageContext,
  SiteBotApi,
  SiteBotEvent,
  SiteBotOptions,
  WidgetController,
  WidgetError,
  WidgetState,
} from './types.js'
// The page-context extractor and client-tool runtime are not re-exported:
// they belong to the lazy panel chunk, and an export here would pull them
// into the launcher's initial payload (docs/07 §1).
export type { ClientToolHandler, ClientToolOptions } from './client-tools.js'

const queue: Array<(element: SiteChatElement) => void> = []
let readyResolve!: () => void
const ready = new Promise<void>((resolve) => (readyResolve = resolve))
export function defineSiteBot(options: SiteBotOptions = {}): SiteChatElement | null {
  try {
    if (!('customElements' in window) || !HTMLElement.prototype.attachShadow) {
      console.warn('[SiteBot] Shadow DOM is not supported.')
      return null
    }
    if (!customElements.get(ELEMENT_NAME)) customElements.define(ELEMENT_NAME, SiteChatElement)
    let element = document.querySelector<SiteChatElement>(ELEMENT_NAME)
    if (!element) {
      element = document.createElement(ELEMENT_NAME) as SiteChatElement
      element.configure(options)
      document.body.append(element)
    } else element.configure(options)
    while (queue.length) {
      const action = queue.shift()
      if (action) action(element)
    }
    void element.ready.then(readyResolve)
    return element
  } catch (error) {
    console.warn('[SiteBot] failed to boot', error)
    return null
  }
}
function withElement(action: (element: SiteChatElement) => void): void {
  try {
    const element = document.querySelector<SiteChatElement>(ELEMENT_NAME)
    if (element) action(element)
    else queue.push(action)
  } catch (error) {
    console.warn('[SiteBot] API call failed', error)
  }
}
export const SiteBot: SiteBotApi = {
  open: () => withElement((element) => element.open()),
  close: () => withElement((element) => element.close()),
  toggle: () => withElement((element) => element.toggle()),
  destroy: () => withElement((element) => element.destroy()),
  isOpen: () => document.querySelector<SiteChatElement>(ELEMENT_NAME)?.isOpen() ?? false,
  send: (text, options) => withElement((element) => element.send(text, options)),
  identify: (jwt) => withElement((element) => element.identify(jwt)),
  clearIdentity: () => withElement((element) => element.clearIdentity()),
  setContext: (data) => withElement((element) => element.setContext(data)),
  setSuggestions: (items) => withElement((element) => element.setSuggestions(items)),
  reset: () => withElement((element) => element.reset()),
  refreshPageContext: () => withElement((element) => element.refreshPageContext()),
  registerTool: (name, handler) => withElement((element) => element.registerTool(name, handler)),
  unregisterTool: (name) => withElement((element) => element.unregisterTool(name)),
  on(event: SiteBotEvent['type'], listener) {
    const handler = (custom: Event) => listener((custom as CustomEvent).detail)
    addEventListener(`sitebot:${event}`, handler)
    return () => {
      removeEventListener(`sitebot:${event}`, handler)
    }
  },
  ready,
  version: VERSION,
}
/**
 * The tag that loaded us. `document.currentScript` is null inside a module
 * script, and docs/07 §1 ships the bundle as `<script type="module">` so the
 * panel can be a separate chunk — hence the fallback lookup by data attribute.
 */
function bootScript(): HTMLScriptElement | null {
  const current = document.currentScript as HTMLScriptElement | null
  return current ?? document.querySelector<HTMLScriptElement>('script[data-endpoint]')
}
if (typeof window !== 'undefined') {
  window.SiteBot = SiteBot
  const script = bootScript()
  if (script?.dataset.endpoint || window.SiteBotConfig)
    queueMicrotask(() => defineSiteBot(window.SiteBotConfig ?? {}))
}
