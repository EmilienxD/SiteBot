import { render } from 'preact'
import type { PublicConfig } from '@sitebot/config'
import { createController } from './chat.js'
import { matchesAny } from './context.js'
import { mergeConfig } from './defaults.js'
import { Panel } from './panel.js'
import { readValue, storageKey, writeValue } from './storage.js'
import { styles } from './styles.js'
import type { SiteBotOptions, WidgetController } from './types.js'

export const ELEMENT_NAME = 'site-chat'
export const DEFAULT_Z_INDEX = 2147483000

export class SiteChatElement extends HTMLElement {
  #root?: ShadowRoot; #mount?: HTMLDivElement; #controller?: WidgetController; #open = false; #options: SiteBotOptions = {}; #launcher?: HTMLButtonElement
  connectedCallback(): void { this.safe(() => void this.boot()) }
  configure(options: SiteBotOptions): void { this.#options = { ...this.#options, ...options }; if (this.isConnected && !this.#root) this.safe(() => void this.boot()) }
  open(): void { this.safe(() => { this.#open = true; this.render(); this.dispatch('open') }) }
  close(): void { this.safe(() => { this.#open = false; this.render(); this.#launcher?.focus(); this.dispatch('close') }) }
  toggle(): void { if (this.#open) this.close(); else this.open() }
  send(text: string): void { this.safe(() => { this.open(); void this.#controller?.send(text) }) }
  identify(jwt: string): void { this.safe(() => this.#controller?.identify(jwt)) }
  reset(): void { this.safe(() => { this.#controller?.reset(); this.dispatch('reset') }) }
  refreshPageContext(): void { this.safe(() => void this.#controller?.refreshPageContext()) }

  async boot(): Promise<void> {
    if (this.#root || !HTMLElement.prototype.attachShadow) return
    const endpoint = this.#options.endpoint ?? this.dataset.endpoint ?? '/api/chat'; const publicKey = this.#options.publicKey ?? this.dataset.key ?? ''; const options = { ...this.#options, endpoint, publicKey }
    this.setAttribute('style', `position:fixed!important;inset:0!important;width:0!important;height:0!important;z-index:${DEFAULT_Z_INDEX}!important;display:block!important`)
    this.#root = this.attachShadow({ mode: 'closed' }); const style = document.createElement('style'); style.textContent = styles; const nonce = options.nonce ?? this.dataset.nonce; if (nonce) style.nonce = nonce; this.#mount = document.createElement('div'); this.#root.append(style, this.#mount)
    const config = mergeConfig(await fetchConfig(endpoint, publicKey)); if (options.position) config.ui.position = options.position; if (options.theme) config.ui.theme.mode = options.theme; this.dataset.theme = config.ui.theme.mode
    this.style.setProperty('--sb-panel-w', `${config.ui.panel.width}px`); this.style.setProperty('--sb-panel-h', `${config.ui.panel.height}px`); this.style.setProperty('--sb-offset-x', `${config.ui.offset.x}px`); this.style.setProperty('--sb-offset-y', `${config.ui.offset.y}px`); this.style.setProperty('z-index', `${config.ui.zIndex}`, 'important'); applyTheme(this, config)
    this.#controller = createController(options, config, () => this.render()); this.#controller.open = () => this.open(); this.#controller.close = () => this.close(); this.#controller.toggle = () => this.toggle()
    if (matchesAny(location.pathname, config.ui.launcher.hideOnPaths)) return
    const remembered = readValue(storageKey(publicKey || 'anonymous', 'open'), 'local') === 'true'; this.#open = Boolean(options.autoOpen ?? (this.dataset.autoOpen === 'true' || (config.ui.panel.rememberOpenState && remembered) || config.ui.panel.openOnFirstVisit))
    setTimeout(() => this.render(), config.ui.launcher.showAfterMs)
    const viewport = typeof visualViewport === 'undefined' ? null : visualViewport
    viewport?.addEventListener('resize', () => this.style.setProperty('--sb-vh', `${viewport.height}px`))
  }

  render(): void {
    const mount = this.#mount
    const controller = this.#controller
    if (!mount || !controller) return
    const ui = controller.config.ui
    render(<>{this.#open && <Panel controller={controller} close={() => this.close()} />}<button ref={(node) => { this.#launcher = node ?? undefined }} class={`launcher ${ui.position === 'bottom-left' ? 'left' : ''} ${ui.launcher.label ? 'pill' : ''}`} aria-label={ui.a11y.launcherAriaLabel} aria-expanded={this.#open} onClick={() => this.toggle()}>{this.#open ? 'X' : icon(ui.launcher.icon)}{ui.launcher.label && <span>{ui.launcher.label}</span>}{ui.launcher.badge.enabled && <span class="badge">{ui.launcher.badge.text}</span>}</button></>, mount)
    if (ui.panel.rememberOpenState) writeValue(storageKey(controller.options.publicKey || 'anonymous', 'open'), String(this.#open), 'local')
  }
  registerTool(name: string, handler: (input: unknown) => unknown | Promise<unknown>): void { this.#controller?.registerTool(name, handler) }
  unregisterTool(name: string): void { this.#controller?.unregisterTool(name) }
  dispatch(type: 'open' | 'close' | 'reset'): void { this.dispatchEvent(new CustomEvent(`sitebot:${type}`, { bubbles: true })); this.#options.onEvent?.({ type }) }
  safe(action: () => void): void { try { action() } catch (error) { console.warn('[SiteBot] widget recovered from an error', error); this.#options.onEvent?.({ type: 'error', detail: error }) } }
}

async function fetchConfig(endpoint: string, key: string): Promise<PublicConfig | undefined> { try { const url = new URL(`${endpoint.replace(/\/$/, '')}/config`, location.href); if (key) url.searchParams.set('key', key); const response = await fetch(url, { credentials: 'same-origin' }); return response.ok ? await response.json() as PublicConfig : undefined } catch { return undefined } }
function icon(name: string): string { return name === 'question' ? '?' : name === 'chat' ? 'Chat' : 'AI' }
function applyTheme(host: HTMLElement, config: PublicConfig): void { const theme = config.ui.theme; if (theme.primary) host.style.setProperty('--sb-primary', theme.primary); host.style.setProperty('--sb-on-primary', theme.onPrimary ?? contrast(theme.primary ?? '#4f46e5')); if (theme.surface) host.style.setProperty('--sb-surface', theme.surface); if (theme.text) host.style.setProperty('--sb-text', theme.text); if (theme.muted) host.style.setProperty('--sb-muted', theme.muted); if (theme.bubbleAssistant) host.style.setProperty('--sb-assistant', theme.bubbleAssistant); if (theme.bubbleUser) host.style.setProperty('--sb-user', theme.bubbleUser); if (theme.radius !== undefined) host.style.setProperty('--sb-panel-radius', `${theme.radius}px`); if (theme.font) host.style.setProperty('--sb-font', theme.font === 'system' ? 'ui-sans-serif,system-ui,sans-serif' : theme.font); if (theme.shadow) host.style.setProperty('--sb-shadow', theme.shadow) }
function contrast(hex: string): string { const match = /^#([\da-f]{6})$/i.exec(hex); if (!match) return '#fff'; const digits = match[1] ?? ''; const rgb = [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4); return 0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0) > 0.179 ? '#000' : '#fff' }
