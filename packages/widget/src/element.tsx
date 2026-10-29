import { createLauncherStrings } from '@sitebot/config/i18n/launcher'
import { hostLocale, localizedUi } from './locale.js'
import { render, type JSX } from 'preact'
import type { PublicConfig } from '@sitebot/config'
import { matchesAny } from './paths.js'
import { mergeConfig } from './defaults.js'
import { Icon, LAUNCHER_GLYPHS } from './icons.js'
import { readValue, storageKey, writeValue } from './storage.js'
import { styles } from './styles.js'
import type { Citation, SiteBotEvent, SiteBotOptions, WidgetController } from './types.js'

export const ELEMENT_NAME = 'site-chat'
export const DEFAULT_Z_INDEX = 2147483000
export const VERSION = '1.0.0'

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
  static get observedAttributes(): string[] {
    return ['data-locale']
  }
  attributeChangedCallback(): void {
    this.updateLocale()
  }
  setLocale(locale?: string): void {
    this.configure({ locale: locale ?? 'auto' })
  }
  updateLocale(): void {
    const override = this.#options.locale ?? this.dataset.locale
    if (this.#resolved) this.#resolved.locale = override
    this.#controller?.setLocale?.(override)
    this.render()
  }
  #root?: ShadowRoot
  #mount?: HTMLDivElement
  #controller?: WidgetController
  #chunk?: PanelChunk
  #config?: PublicConfig
  #configFailed = false
  /** Boot's /config carried this session's pending-run probe (docs/03 §6). */
  #probedSession = false
  #navigated = false
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
  #cleanup: Array<() => void> = []
  #readyResolve!: () => void
  readonly ready: Promise<void> = new Promise((resolve) => (this.#readyResolve = resolve))
  readonly version = VERSION

  connectedCallback(): void {
    this.safe(() => void this.boot())
  }
  disconnectedCallback(): void {
    for (const cleanup of this.#cleanup.splice(0)) cleanup()
  }
  configure(options: SiteBotOptions): void {
    this.#options = { ...this.#options, ...options }
    this.updateLocale()
    if (this.isConnected && !this.#root) this.safe(() => void this.boot())
  }
  open(): void {
    this.safe(() => {
      if (this.#open) return
      this.#open = true
      void this.load()
      this.render()
      this.dispatch('open', {})
    })
  }
  close(): void {
    this.safe(() => {
      if (!this.#open) return
      this.#open = false
      this.render()
      // docs/07 §8: focus returns to the launcher on close.
      this.#launcher?.focus()
      this.dispatch('close', {})
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
      this.dispatch('reset', {})
    })
  }
  destroy(): void {
    this.safe(() => {
      this.#controller?.stop()
      if (this.#mount) render(null, this.#mount)
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
    this.safe(() => {
      if (this.#config) this.#config.ui.messages.suggestions = items
      this.withController((controller) => controller.setSuggestions(items))
    })
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
  registerTool(name: string, handler: (input: unknown) => unknown | Promise<unknown>): void {
    this.safe(() => this.withController((controller) => controller.registerTool(name, handler)))
  }
  unregisterTool(name: string): void {
    this.safe(() => this.withController((controller) => controller.unregisterTool(name)))
  }

  /**
   * The cheap half of boot: shadow root, styles, config, launcher. Guarded so
   * `connectedCallback` and `configure` can both call it and only one runs.
   */
  boot(): Promise<void> {
    this.#booting ??= this.mount().catch((error: unknown) => {
      console.warn('[SiteBot] failed to boot', error)
    })
    return this.#booting
  }

  async mount(): Promise<void> {
    if (this.#root || !HTMLElement.prototype.attachShadow) return
    const endpoint = this.#options.endpoint ?? this.dataset.endpoint ?? '/api/chat'
    const publicKey = this.#options.publicKey ?? this.dataset.key ?? ''
    const options: ResolvedOptions = {
      ...this.#options,
      locale: this.#options.locale ?? this.dataset.locale,
      endpoint,
      publicKey,
    }
    this.setAttribute(
      'style',
      `position:fixed!important;inset:0!important;width:0!important;height:0!important;z-index:${DEFAULT_Z_INDEX}!important;display:block!important`,
    )
    this.#root = this.attachShadow({ mode: 'closed' })
    this.#root.append(this.styleElement(styles, options))
    this.#mount = document.createElement('div')
    this.#root.append(this.#mount)
    const prefix = publicKey || 'anonymous'
    const sessionKey = storageKey(prefix, 'sessionId')
    const storedSessionId = readValue(sessionKey, 'session') ?? readValue(sessionKey, 'local')
    const remote = await fetchConfig(endpoint, publicKey, storedSessionId ?? undefined)
    this.#configFailed = remote === undefined
    this.#probedSession = remote !== undefined && storedSessionId !== null
    const config = mergeConfig(remote)
    if (options.position) config.ui.position = options.position
    if (options.theme) config.ui.theme.mode = options.theme
    this.#config = config
    this.#resolved = options
    this.applyConfig(config)
    // docs/02 §11 `resetOnNavigate`: a full page load onto a different path is
    // a navigation too, not only an SPA route change.
    const pathKey = storageKey(prefix, 'path')
    const lastPath = readValue(pathKey, 'session')
    this.#navigated = lastPath !== null && lastPath !== location.pathname
    writeValue(pathKey, location.pathname, 'session')
    const onPopState = () => {
      if (this.#config?.ui.behaviour.resetOnNavigate) this.#controller?.reset()
    }
    const languageObserver = new MutationObserver(() => this.updateLocale())
    languageObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['lang'],
    })
    const onLanguage = () => this.updateLocale()
    addEventListener('languagechange', onLanguage)
    this.#cleanup.push(
      () => languageObserver.disconnect(),
      () => removeEventListener('languagechange', onLanguage),
    )
    addEventListener('popstate', onPopState)
    this.#cleanup.push(() => removeEventListener('popstate', onPopState))
    this.#readyResolve()
    this.dispatch('ready', { config })
    if (matchesAny(location.pathname, config.ui.launcher.hideOnPaths)) return
    const remembered = readValue(storageKey(prefix, 'open'), 'local') === 'true'
    this.#open = Boolean(
      options.autoOpen ??
      (this.dataset.autoOpen === 'true' ||
        (config.ui.panel.rememberOpenState && remembered) ||
        config.ui.panel.openOnFirstVisit),
    )
    if (this.#open) void this.load()
    const timer = setTimeout(() => this.render(), config.ui.launcher.showAfterMs)
    this.#cleanup.push(() => clearTimeout(timer))
    const viewport = typeof visualViewport === 'undefined' ? null : visualViewport
    if (viewport) {
      // docs/07 §6: keep the composer above the on-screen keyboard.
      const onResize = () => this.style.setProperty('--sb-vh', `${viewport.height}px`)
      viewport.addEventListener('resize', onResize)
      this.#cleanup.push(() => viewport.removeEventListener('resize', onResize))
    }
  }

  applyConfig(config: PublicConfig): void {
    this.dataset.theme = config.ui.theme.mode
    this.style.setProperty('--sb-panel-w', `${config.ui.panel.width}px`)
    this.style.setProperty('--sb-panel-h', `${config.ui.panel.height}px`)
    this.style.setProperty('--sb-offset-x', `${config.ui.offset.x}px`)
    this.style.setProperty('--sb-offset-y', `${config.ui.offset.y}px`)
    this.style.setProperty('z-index', `${config.ui.zIndex}`, 'important')
    applyTheme(this, config)
  }

  /**
   * docs/07 §10: "`/config` fetch fails — launcher renders with built-in
   * defaults; panel shows a retry state on open." This is the retry.
   */
  async retryConfig(): Promise<void> {
    const options = this.#resolved
    if (!options) return
    const remote = await fetchConfig(options.endpoint, options.publicKey)
    if (remote === undefined) return
    this.#configFailed = false
    const config = mergeConfig(remote)
    if (options.position) config.ui.position = options.position
    if (options.theme) config.ui.theme.mode = options.theme
    this.#config = config
    this.applyConfig(config)
    if (this.#chunk) this.buildController(this.#chunk)
    this.render()
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
      // No config means boot bailed out (no Shadow DOM). Clear the guard so a
      // later call can try again rather than latching a failure forever.
      if (!this.#config || !this.#resolved || !this.#root) {
        this.#loading = undefined
        return
      }
      const chunk = await import('./panel-chunk.js')
      this.#chunk = chunk
      this.#root.append(this.styleElement(chunk.panelStyles, this.#resolved))
      const controller = this.buildController(chunk)
      if (this.#config.ui.behaviour.resetOnNavigate && this.#navigated) controller.reset()
      if (this.#config.pending) controller.rehydratePending(this.#config.pending)
      else if (this.#probedSession) controller.expireStale()
      for (const action of this.#queue.splice(0)) action(controller)
      this.render()
    } catch (error) {
      this.#loading = undefined
      console.warn('[SiteBot] failed to load the chat panel', error)
      this.dispatch('error', {
        code: 'chunk_load_failed',
        message: createLauncherStrings(
          this.#config!.ui,
          hostLocale(this.#config!.ui, this.#resolved?.locale),
        )('chatLoadFailed'),
      })
    }
  }

  buildController(chunk: PanelChunk): WidgetController {
    const options = this.#resolved!
    const controller = chunk.createController(
      // The controller reports through `onEvent`; route it through `dispatch`
      // so `SiteBot.on(...)` DOM listeners hear controller events as well.
      { ...options, onEvent: (event) => this.dispatch(event.type, event.detail) },
      this.#config!,
      () => this.render(),
    )
    controller.open = () => this.open()
    controller.close = () => this.close()
    controller.toggle = () => this.toggle()
    controller.clickCitation = (citation) => this.citationClick(citation)
    this.#controller = controller
    return controller
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
    const locale = hostLocale(config.ui, this.#resolved?.locale)
    const ui = localizedUi(config.ui, locale)
    const t = createLauncherStrings(ui, locale)
    const chunk = this.#chunk
    const controller = this.#controller
    const close = () => this.close()
    const offline = this.#configFailed ? { retry: () => void this.retryConfig() } : undefined
    let panel: JSX.Element | null = null
    if (this.#open && controller && chunk) {
      panel =
        ui.isolation === 'iframe' ? (
          <chunk.IframePanel
            controller={controller}
            close={close}
            offline={offline}
            styleText={styles + chunk.panelStyles}
            variables={hostVariables(this)}
            theme={ui.theme.mode}
          />
        ) : (
          <chunk.PanelBoundary close={close} t={chunk.createStrings(config.ui, locale)}>
            <chunk.Panel controller={controller} close={close} offline={offline} />
          </chunk.PanelBoundary>
        )
    }
    const left = ui.position === 'bottom-left'
    render(
      <>
        {panel}
        <button
          ref={(node) => {
            this.#launcher = node ?? undefined
          }}
          type="button"
          class={`launcher${left ? ' left' : ''}${ui.launcher.label ? ' pill' : ''}${this.#open ? ' open' : ''}`}
          lang={locale}
          aria-label={t('launcherAriaLabel')}
          aria-expanded={this.#open}
          // docs/07 §8. Only while the panel is in this shadow root: in iframe
          // mode it lives in another document, where an id reference is void.
          aria-controls={panel !== null && ui.isolation !== 'iframe' ? 'sitebot-panel' : undefined}
          aria-haspopup="dialog"
          tabIndex={this.#open ? -1 : 0}
          onClick={() => this.toggle()}
        >
          {ui.launcher.icon === 'custom' && ui.launcher.iconUrl ? (
            <img src={ui.launcher.iconUrl} alt="" />
          ) : (
            <Icon
              d={
                LAUNCHER_GLYPHS[
                  ui.launcher.icon === 'chat' || ui.launcher.icon === 'question'
                    ? ui.launcher.icon
                    : 'sparkle'
                ]
              }
              size={24}
            />
          )}
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

  dispatch(type: SiteBotEvent['type'], detail?: unknown): void {
    try {
      this.dispatchEvent(new CustomEvent(`sitebot:${type}`, { bubbles: true, detail }))
      this.#options.onEvent?.({ type, detail })
    } catch (error) {
      console.warn('[SiteBot] an event handler threw', error)
    }
  }
  /** docs/03 §9 — a citation chip click opens the source and notifies the host. */
  citationClick(citation: Citation): void {
    this.safe(() => {
      window.open(citation.url, '_blank', 'noopener,noreferrer')
      this.dispatch('citation-click', { url: citation.url, title: citation.title })
    })
  }
  safe(action: () => void): void {
    try {
      action()
    } catch (error) {
      console.warn('[SiteBot] widget recovered from an error', error)
      try {
        this.#options.onEvent?.({ type: 'error', detail: error })
      } catch {
        /* never throw into the host */
      }
    }
  }
  styleElement(text: string, options: SiteBotOptions): HTMLStyleElement {
    const style = document.createElement('style')
    style.textContent = text
    const nonce = options.nonce ?? this.dataset.nonce
    if (nonce) style.nonce = nonce
    return style
  }
}

async function fetchConfig(
  endpoint: string,
  key: string,
  sessionId?: string,
): Promise<PublicConfig | undefined> {
  try {
    const url = new URL(`${endpoint.replace(/\/$/, '')}/config`, location.href)
    if (key) url.searchParams.set('key', key)
    if (sessionId) url.searchParams.set('sessionId', sessionId)
    const response = await fetch(url, { credentials: 'same-origin' })
    return response.ok ? ((await response.json()) as PublicConfig) : undefined
  } catch {
    return undefined
  }
}

/** The `--sb-*` properties set inline on the host, for the iframe's `:root`. */
function hostVariables(host: HTMLElement): string {
  const declarations: string[] = []
  for (let index = 0; index < host.style.length; index += 1) {
    const name = host.style.item(index)
    if (name.startsWith('--sb-')) declarations.push(`${name}:${host.style.getPropertyValue(name)}`)
  }
  return declarations.join(';')
}

function applyTheme(host: HTMLElement, config: PublicConfig): void {
  const theme = config.ui.theme
  const set = (name: string, value: string | undefined) => {
    if (value) host.style.setProperty(name, value)
  }
  set('--sb-primary', theme.primary)
  // docs/07 §4: `--sb-on-primary` is computed by luminance, not trusted.
  host.style.setProperty(
    '--sb-on-primary',
    theme.onPrimary ?? readableOn(theme.primary ?? '#4f46e5'),
  )
  set('--sb-surface', theme.surface)
  set('--sb-pill-bg', theme.surface)
  set('--sb-text', theme.text)
  set('--sb-muted', theme.muted)
  if (theme.bubbleAssistant) {
    set('--sb-bubble-assistant-bg', theme.bubbleAssistant)
    set('--sb-bubble-assistant-fg', readableOn(theme.bubbleAssistant, theme.text))
  }
  if (theme.bubbleUser) {
    set('--sb-bubble-user-bg', theme.bubbleUser)
    set('--sb-bubble-user-fg', readableOn(theme.bubbleUser))
  }
  if (theme.radius !== undefined) host.style.setProperty('--sb-panel-radius', `${theme.radius}px`)
  if (theme.font === 'inherit') {
    // `:host { all: initial }` cuts inheritance, so "inherit" means reading
    // the page's font once and pinning it.
    set('--sb-font', getComputedStyle(document.body).fontFamily)
  } else if (theme.font === 'system') {
    set('--sb-font', 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif')
  } else set('--sb-font', theme.font)
  set('--sb-shadow', theme.shadow)
}

/** Black or white, whichever reads on `background` — WCAG relative luminance. */
export function readableOn(background: string, preferred?: string): string {
  const luminance = relativeLuminance(background)
  if (luminance === undefined) return preferred ?? '#fff'
  return luminance > 0.179 ? '#000' : '#fff'
}

export function relativeLuminance(hex: string): number | undefined {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim())
  if (!match) return undefined
  let digits = match[1] ?? ''
  if (digits.length === 3) digits = [...digits].map((digit) => digit + digit).join('')
  const [r, g, b] = [0, 2, 4]
    .map((index) => parseInt(digits.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}
