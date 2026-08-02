import type { PublicConfig } from '@sitebot/config'

export const defaultConfig: PublicConfig = {
  name: 'Assistant', mode: 'chat', capabilities: { streaming: true, fileUpload: false, clientTools: [], routes: [], authMode: 'none' },
  ui: {
    position: 'bottom-right', offset: { x: 24, y: 24 }, zIndex: 2147483000, isolation: 'shadow',
    launcher: { icon: 'sparkle', showAfterMs: 0, hideOnPaths: [], badge: { enabled: false, text: '' } },
    panel: { width: 400, height: 640, showAvatar: true, showClose: true, openOnFirstVisit: false, rememberOpenState: true },
    theme: { mode: 'auto' }, messages: { placeholder: 'Ask a question…', suggestions: [], suggestionsPersist: false, errorMessage: 'Something went wrong. Please try again.', emptyStateAfterMs: 0 },
    behaviour: { streaming: true, showTypingIndicator: true, showReasoning: false, markdown: true, allowFileUpload: false, persistHistory: true, resetOnNavigate: false, sound: false, sessionScope: 'tab', navigateAllowlist: [] },
    pageContext: { excludePaths: [], redactSelectors: ['input', '[data-private]', '.pii'], readSelectorDenylist: ['input[type=password]', '[data-sensitive]', 'iframe'] },
    extract: { selector: 'main, article, [role="main"]', strip: [] }, a11y: { launcherAriaLabel: 'Open chat assistant', panelAriaLabel: 'Chat assistant' }, locale: 'auto', strings: {},
  },
}

export function mergeConfig(remote?: PublicConfig): PublicConfig {
  if (!remote) return structuredClone(defaultConfig)
  return { ...defaultConfig, ...remote, capabilities: { ...defaultConfig.capabilities, ...remote.capabilities }, ui: { ...defaultConfig.ui, ...remote.ui, offset: { ...defaultConfig.ui.offset, ...remote.ui.offset }, launcher: { ...defaultConfig.ui.launcher, ...remote.ui.launcher, badge: { ...defaultConfig.ui.launcher.badge, ...remote.ui.launcher.badge } }, panel: { ...defaultConfig.ui.panel, ...remote.ui.panel }, theme: { ...defaultConfig.ui.theme, ...remote.ui.theme }, messages: { ...defaultConfig.ui.messages, ...remote.ui.messages }, behaviour: { ...defaultConfig.ui.behaviour, ...remote.ui.behaviour }, pageContext: { ...defaultConfig.ui.pageContext, ...remote.ui.pageContext }, extract: { ...defaultConfig.ui.extract, ...remote.ui.extract }, a11y: { ...defaultConfig.ui.a11y, ...remote.ui.a11y } } }
}
