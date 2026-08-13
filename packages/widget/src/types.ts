import type { PublicConfig, Ui } from '@sitebot/config'
import type { UIMessage } from 'ai'

export type WidgetState =
  'idle' | 'submitted' | 'streaming' | 'executing-client-tool' | 'awaiting-approval' | 'error'
export interface SiteBotOptions {
  endpoint?: string
  publicKey?: string
  autoOpen?: boolean
  position?: Ui['position']
  theme?: Ui['theme']['mode']
  nonce?: string
  onEvent?: (event: SiteBotEvent) => void
}

/** One item of a `data-citations` message part — docs/03-protocol.md §4. */
export interface Citation {
  id: string
  title: string
  url: string
  snippet: string
  score: number
}

export interface SiteBotEvent {
  type:
    | 'ready'
    | 'open'
    | 'close'
    | 'message'
    | 'tool'
    | 'approval'
    | 'handoff'
    | 'feedback'
    | 'error'
    | 'reset'
    | 'citation-click'
  detail?: unknown
}
/** Fired when a rendered source chip is activated. */
export interface CitationClickDetail {
  url: string
  title: string
}

export interface PageContext {
  url: string
  path: string
  title: string
  description: string
  locale: string
  referrer: string
  selection: string | null
  extract?: string
  extractHash?: string
  meta: Record<string, string>
  custom?: Record<string, unknown>
}
export interface WidgetController {
  options: Required<Pick<SiteBotOptions, 'endpoint' | 'publicKey'>> & SiteBotOptions
  config: PublicConfig
  readonly messages: UIMessage[]
  readonly state: WidgetState
  readonly error?: Error
  readonly retryAfter?: number
  readonly composerDisabled: boolean
  open(): void
  close(): void
  toggle(): void
  send(text: string, options?: { hidden?: boolean }): Promise<void>
  stop(): void
  retry(): Promise<void>
  reset(): void
  identify(jwt: string | null): void
  clearIdentity(): void
  setContext(data: Record<string, unknown>): void
  setSuggestions(items: NonNullable<PublicConfig['ui']['messages']['suggestions']>): void
  refreshPageContext(): Promise<PageContext | null>
  registerTool(name: string, handler: (input: unknown) => unknown | Promise<unknown>): void
  unregisterTool(name: string): void
  approve(approvalId: string, approved: boolean): Promise<void>
  feedback(messageId: string, rating: 'up' | 'down'): Promise<void>
  clickCitation?(citation: Citation): void
  subscribe(listener: () => void): () => void
}
export interface SiteBotApi {
  open(): void
  close(): void
  toggle(): void
  destroy(): void
  isOpen(): boolean
  send(text: string, options?: { hidden?: boolean }): void
  identify(jwt: string): void
  clearIdentity(): void
  setContext(data: Record<string, unknown>): void
  setSuggestions(items: NonNullable<PublicConfig['ui']['messages']['suggestions']>): void
  reset(): void
  refreshPageContext(): void
  registerTool(name: string, fn: (input: unknown) => unknown | Promise<unknown>): void
  unregisterTool(name: string): void
  ready: Promise<void>
  version: string
  on(event: SiteBotEvent['type'], listener: (detail?: unknown) => void): () => void
}
declare global {
  interface Window {
    SiteBot?: SiteBotApi
    SiteBotConfig?: SiteBotOptions
  }
}
