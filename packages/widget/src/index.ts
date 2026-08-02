import { ELEMENT_NAME, SiteChatElement } from './element.js'
import type { SiteBotApi, SiteBotEvent, SiteBotOptions } from './types.js'

export { DEFAULT_Z_INDEX, ELEMENT_NAME, SiteChatElement } from './element.js'
export { storageKey } from './storage.js'
export { extractPageContext, matchesAny } from './context.js'
export type { PageContext, SiteBotApi, SiteBotEvent, SiteBotOptions, WidgetController, WidgetState } from './types.js'

const queue: Array<(element: SiteChatElement) => void> = []
export function defineSiteBot(options: SiteBotOptions = {}): SiteChatElement | null { try { if (!('customElements' in window) || !HTMLElement.prototype.attachShadow) { console.warn('[SiteBot] Shadow DOM is not supported.'); return null } if (!customElements.get(ELEMENT_NAME)) customElements.define(ELEMENT_NAME, SiteChatElement); let element = document.querySelector<SiteChatElement>(ELEMENT_NAME); if (!element) { element = document.createElement(ELEMENT_NAME) as SiteChatElement; element.configure(options); document.body.append(element) } else element.configure(options); while (queue.length) { const action = queue.shift(); if (action) action(element) } return element } catch (error) { console.warn('[SiteBot] failed to boot', error); return null } }
function withElement(action: (element: SiteChatElement) => void): void { try { const element = document.querySelector<SiteChatElement>(ELEMENT_NAME); if (element) action(element); else queue.push(action) } catch (error) { console.warn('[SiteBot] API call failed', error) } }
export const SiteBot: SiteBotApi = { open: () => withElement((element) => element.open()), close: () => withElement((element) => element.close()), toggle: () => withElement((element) => element.toggle()), send: (text) => withElement((element) => element.send(text)), identify: (jwt) => withElement((element) => element.identify(jwt)), reset: () => withElement((element) => element.reset()), refreshPageContext: () => withElement((element) => element.refreshPageContext()), on(event: SiteBotEvent['type'], listener) { const handler = (custom: Event) => listener((custom as CustomEvent).detail); addEventListener(`sitebot:${event}`, handler); return () => { removeEventListener(`sitebot:${event}`, handler) } } }
if (typeof window !== 'undefined') { window.SiteBot = SiteBot; const script = document.currentScript as HTMLScriptElement | null; if (script?.dataset.endpoint || window.SiteBotConfig) queueMicrotask(() => defineSiteBot(window.SiteBotConfig ?? {})) }
