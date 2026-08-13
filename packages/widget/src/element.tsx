import { render } from 'preact'
import type { PublicConfig } from '@sitebot/config'
import { matchesAny } from './context.js'
import { mergeConfig } from './defaults.js'
import { readValue, storageKey, writeValue } from './storage.js'
import { styles } from './styles.js'
import type { Citation, SiteBotOptions, WidgetController } from './types.js'

export const ELEMENT_NAME = 'site-chat'
export const DEFAULT_Z_INDEX = 2147483000

/**
 * Type-only view of the lazy chunk: `import type` is erased at compile time, so
 * this does not create a static edge to `./panel-chunk.js` — the dynamic
 * `import()` in `loadPanel` stays the only one, which is what keeps the chunk
 * out of the initial payload.
 */
import type * as PanelModule from './panel-chunk.js'
type PanelChunk = typeof PanelModule

/** The options every code path downstream of boot can rely on being present. */
type ResolvedOptions = SiteBotOptions & { endpoint: string; publicKey: string }

export class SiteChatElement extends HTMLElement {
  #root?: ShadowRoot
  #mount?: HTMLDivElement
  #controller?: WidgetController
  #chunk?: PanelChunk
  #config?: PublicConfig
  #resolved?: ResolvedOptions
  #booting?: Promise<void>
  #loading?: Promise<void>
  /**
   * Calls that need the chat controller but arrived before the chunk loaded.
   * `SiteBot.identify(...)` on page load must not drag the panel in — it waits
   * here and is applied the moment the controller exists.
   */
  #queue: Array<(controller: WidgetController) => void> = []
  #open = false
  #options: SiteBotOptions = {}
  #launcher?: HTMLButtonElement
  #readyResolve!: () => void
  readonly ready: Promise<void> = new Promise((resolve) => (this.#readyResolve = resolve))
  readonly version = '1.0.0'
  connectedCallback(): void {
    this.safe(() => void this.boot())
  }
  configure(options: SiteBotOptions): void {
    this.#options = { ...this.#options, ...options }
    if (this.isConnected && !this.#root) this.safe(() => void this.boot())
  }
  open(): void {
    this.safe(() => {
      this.#open = true
      void this.load()
      this.render()
      this.dispatch('open')
    })
  }
  close(): void {
    this.safe(() => {
      this.#open = false
      this.render()
      this.#launcher?.focus()
      this.dispatch('close')
    })
  }
  toggle(): void {
    if (this.#open) this.close()
    else this.open()
  }
  send(text: string, sendOptions?: { hidden?: boolean }): void {
    this.safe(() => {
      this.open()
      this.withController((controller) => void controller.send(text, sendOptions))
    })
  }
  identify(jwt: string): void {
    this.safe(() => this.withController((controller) => controller.identify(jwt)))
  }
  reset(): void {
    this.safe(() => {
      this.withController((controller) => controller.reset())
      this.dispatch('reset')
    })
  }
  destroy(): void {
    this.safe(() => {
      this.#controller?.stop()
      this.remove()
    })
  }
  isOpen(): boolean {
    return this.#open
  }
  clearIdentity(): void {
    this.safe(() => this.withController((controller) => controller.clearIdentity()))
  }
  setContext(data: Record<string, unknown>): void {
    this.safe(() => this.withController((controller) => controller.setContext(data)))
  }
  setSuggestions(items: NonNullable<PublicConfig['ui']['messages']['suggestions']>): void {
    this.safe(() => this.withController((controller) => controller.setSuggestions(items)))
  }
  refreshPageContext(): void {
    this.safe(() =>
      this.withController((controller) =>
        controller.config.ui.behaviour.resetOnNavigate
          ? controller.reset()
          : void controller.refreshPageContext(),
      ),
    )
  }

  /**
   * The cheap half of boot: shadow root, styles, config, launcher. Guarded so
   * `connectedCallback` and `configure` can both call it and only one runs.
   */
  boot(): Promise<void> {
    this.#booting ??= this.mount()
    return this.#booting
  }

  async mount(): Promise<void> {
    if (this.#root || !HTMLElement.prototype.attachShadow) return
    const endpoint = this.#options.endpoint ?? this.dataset.endpoint ?? '/api/chat'
    const publicKey = this.#options.publicKey ?? this.dataset.key ?? ''
    const options: ResolvedOptions = { ...this.#options, endpoint, publicKey }
    this.setAttribute(
      'style',
      `position:fixed!important;inset:0!important;width:0!important;height:0!important;z-index:${DEFAULT_Z_INDEX}!important;display:block!important`,
    )
    this.#root = this.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = styles
    const nonce = options.nonce ?? this.dataset.nonce
    if (nonce) style.nonce = nonce
    this.#mount = document.createElement('div')
    this.#root.append(style, this.#mount)
    const config = mergeConfig(await fetchConfig(endpoint, publicKey))
    if (options.position) config.ui.position = options.position
    if (options.theme) config.ui.theme.mode = options.theme
    this.#config = config
    this.#resolved = options
    this.#readyResolve()
    this.dispatch('ready', { config })
    this.dataset.theme = config.ui.theme.mode
    this.style.setProperty('--sb-panel-w', `${config.ui.panel.width}px`)
    this.style.setProperty('--sb-panel-h', `${config.ui.panel.height}px`)
    this.style.setProperty('--sb-offset-x', `${config.ui.offset.x}px`)
    this.style.setProperty('--sb-offset-y', `${config.ui.offset.y}px`)
    this.style.setProperty('z-index', `${config.ui.zIndex}`, 'important')
    applyTheme(this, config)
    if (matchesAny(location.pathname, config.ui.launcher.hideOnPaths)) return
    const remembered = readValue(storageKey(publicKey || 'anonymous', 'open'), 'local') === 'true'
    this.#open = Boolean(
      options.autoOpen ??
      (this.dataset.autoOpen === 'true' ||
        (config.ui.panel.rememberOpenState && remembered) ||
        config.ui.panel.openOnFirstVisit),
    )
    if (this.#open) void this.load()
    setTimeout(() => this.render(), config.ui.launcher.showAfterMs)
    const viewport = typeof visualViewport === 'undefined' ? null : visualViewport
    viewport?.addEventListener('resize', () =>
      this.style.setProperty('--sb-vh', `${viewport.height}px`),
    )
  }

  /**
   * Pull in the panel chunk and build the chat controller — docs/07 §1. Every
   * entry point that needs the chat half calls this and shares one promise, so
   * the network request happens once no matter how the panel is opened.
   */
  load(): Promise<void> {
    this.#loading ??= this.loadPanel()
    return this.#loading
  }

  async loadPanel(): Promise<void> {
    try {
      await this.boot()
      const config = this.#config
      const options = this.#resolved
      // No config means boot bailed out (no Shadow DOM). Clear the guard so a
      // later call can try again rather than latching a failure forever.
      if (!config || !options) {
        this.#loading = undefined
        return
      }
      const chunk = await import('./panel-chunk.js')
      this.#chunk = chunk
      const controller = chunk.createController(options, config, () => this.render())
      controller.open = () => this.open()
      controller.close = () => this.close()
      controller.toggle = () => this.toggle()
      controller.clickCitation = (citation) => this.citationClick(citation)
      this.#controller = controller
      for (const action of this.#queue.splice(0)) action(controller)
      this.render()
    } catch (error) {
      this.#loading = undefined
      console.warn('[SiteBot] failed to load the chat panel', error)
      this.#options.onEvent?.({ type: 'error', detail: error })
    }
  }

  /** Run `action` now if the controller exists, otherwise when it arrives. */
  withController(action: (controller: WidgetController) => void): void {
    if (this.#controller) action(this.#controller)
    else this.#queue.push(action)
  }

  render(): void {
    const mount = this.#mount
    const config = this.#config
    if (!mount || !config) return
    const ui = config.ui
    const Panel = this.#chunk?.Panel
    const IframePanel = this.#chunk?.IframePanel
    const controller = this.#controller
    render(
      <>
        {this.#open &&
          controller &&
          (config.ui.isolation === 'iframe' && IframePanel ? (
            <IframePanel controller={controller} close={() => this.close()} styleText={styles} />
          ) : Panel ? (
            <Panel controller={controller} close={() => this.close()} />
          ) : null)}
        <button
          ref={(node) => {
            this.#launcher = node ?? undefined
          }}
          class={`launcher ${ui.position === 'bottom-left' ? 'left' : ''} ${ui.launcher.label ? 'pill' : ''}`}
          aria-label={ui.a11y.launcherAriaLabel}
          aria-expanded={this.#open}
          onClick={() => this.toggle()}
        >
          {this.#open ? 'X' : icon(ui.launcher.icon)}
          {ui.launcher.label && <span>{ui.launcher.label}</span>}
          {ui.launcher.badge.enabled && <span class="badge">{ui.launcher.badge.text}</span>}
        </button>
      </>,
      mount,
    )
    if (ui.panel.rememberOpenState)
      writeValue(
        storageKey(this.#resolved?.publicKey || 'anonymous', 'open'),
        String(this.#open),
        'local',
      )
  }
  registerTool(name: string, handler: (input: unknown) => unknown | Promise<unknown>): void {
    this.withController((controller) => controller.registerTool(name, handler))
  }
  unregisterTool(name: string): void {
    this.withController((controller) => controller.unregisterTool(name))
  }
  dispatch(type: 'open' | 'close' | 'reset' | 'ready', detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(`sitebot:${type}`, { bubbles: true, detail }))
    this.#options.onEvent?.({ type, detail })
  }
  /** docs/03 §7 — a citation chip click opens the source and notifies the host. */
  citationClick(citation: Citation): void {
    this.safe(() => {
      window.open(citation.url, '_blank', 'noopener,noreferrer')
      const detail = { url: citation.url, title: citation.title }
      this.dispatchEvent(new CustomEvent('sitebot:citation-click', { bubbles: true, detail }))
      this.#options.onEvent?.({ type: 'citation-click', detail })
    })
  }
  safe(action: () => void): void {
    try {
      action()
    } catch (error) {
      console.warn('[SiteBot] widget recovered from an error', error)
      this.#options.onEvent?.({ type: 'error', detail: error })
    }
  }
}

async function fetchConfig(endpoint: string, key: string): Promise<PublicConfig | undefined> {
  try {
    const url = new URL(`${endpoint.replace(/\/$/, '')}/config`, location.href)
    if (key) url.searchParams.set('key', key)
    const response = await fetch(url, { credentials: 'same-origin' })
    return response.ok ? ((await response.json()) as PublicConfig) : undefined
  } catch {
    return undefined
  }
}
function icon(name: string) {
  const path =
    name === 'question'
      ? 'M12 17h.01M9.5 9a2.5 2.5 0 1 1 4.3 1.8c-.9.8-1.8 1.1-1.8 2.7'
      : name === 'chat'
        ? 'M4 5h16v11H8l-4 3V5Z'
        : 'M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z'
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}
function applyTheme(host: HTMLElement, config: PublicConfig): void {
  const theme = config.ui.theme
  if (theme.primary) host.style.setProperty('--sb-primary', theme.primary)
  host.style.setProperty('--sb-on-primary', theme.onPrimary ?? contrast(theme.primary ?? '#4f46e5'))
  if (theme.surface) host.style.setProperty('--sb-surface', theme.surface)
  if (theme.text) host.style.setProperty('--sb-text', theme.text)
  if (theme.muted) host.style.setProperty('--sb-muted', theme.muted)
  if (theme.bubbleAssistant) host.style.setProperty('--sb-assistant', theme.bubbleAssistant)
  if (theme.bubbleUser) host.style.setProperty('--sb-user', theme.bubbleUser)
  if (theme.radius !== undefined) host.style.setProperty('--sb-panel-radius', `${theme.radius}px`)
  if (theme.font)
    host.style.setProperty(
      '--sb-font',
      theme.font === 'system' ? 'ui-sans-serif,system-ui,sans-serif' : theme.font,
    )
  if (theme.shadow) host.style.setProperty('--sb-shadow', theme.shadow)
}
function contrast(hex: string): string {
  const match = /^#([\da-f]{6})$/i.exec(hex)
  if (!match) return '#fff'
  const digits = match[1] ?? ''
  const rgb = [0, 2, 4]
    .map((index) => parseInt(digits.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0) > 0.179
    ? '#000'
    : '#fff'
}
