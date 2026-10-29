import type { MessageKey } from '@sitebot/config/i18n'
import type { PublicConfig, Ui } from '@sitebot/config'

/**
 * One part of a message, as the AI SDK UI Message Stream builds it — docs/03
 * §3. Structural rather than imported from `ai`: the widget no longer ships
 * that package (docs/07 §1), and the shape is the wire contract, not a type
 * the SDK owns on our behalf.
 */
export interface UIPart {
  type: string
  [key: string]: unknown
}

export interface UIMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: UIPart[]
  metadata?: unknown
}

export type WidgetState =
  'idle' | 'submitted' | 'streaming' | 'executing-client-tool' | 'awaiting-approval' | 'error'
export interface SiteBotOptions {
  endpoint?: string
  publicKey?: string
  autoOpen?: boolean
  position?: Ui['position']
  theme?: Ui['theme']['mode']
  /** Host locale override; auto/undefined follows the host document. */
  locale?: string
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
  lang?: string
}

export interface HandoffData {
  target: Record<string, unknown>
  ticketUrl?: string
  message: string
  messageKey?: MessageKey
}

export interface InlineErrorData {
  messageKey?: MessageKey
  values?: Record<string, string | number>
  code: string
  message: string
  retryable: boolean
}

/**
 * A failed request, reduced to what the widget may show — docs/07 §10. The
 * provider's own error text never reaches this type.
 */
export interface WidgetError {
  messageKey?: MessageKey
  values?: Record<string, string | number>
  code:
    | 'network'
    | 'rate_limited'
    | 'budget_exceeded'
    | 'run_expired'
    | 'provider_error'
    | (string & {})
  message: string
  retryable: boolean
  /** Seconds, from `Retry-After`, for `rate_limited`. */
  retryAfter?: number
}

export interface UsageData {
  inputTokens: number
  outputTokens: number
  costUsd: number
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
  readonly locale: string
  readonly suggestions?: PublicConfig['ui']['messages']['suggestions']
  readonly messages: UIMessage[]
  readonly state: WidgetState
  readonly error?: WidgetError
  readonly retryAfter?: number
  readonly composerDisabled: boolean
  readonly statusText?: string
  readonly handoff?: HandoffData
  readonly inlineError?: InlineErrorData
  readonly usage?: UsageData
  open(): void
  close(): void
  toggle(): void
  send(text: string, options?: { hidden?: boolean }): Promise<void>
  stop(): void
  retry(): Promise<void>
  reset(): void
  identify(jwt: string | null): void
  clearIdentity(): void
  setLocale(locale?: string): void
  setContext(data: Record<string, unknown>): void
  setSuggestions(items: NonNullable<PublicConfig['ui']['messages']['suggestions']>): void
  rehydratePending(pending: NonNullable<PublicConfig['pending']>): void
  /** The session probe found nothing pending: settle cached cards and chips. */
  expireStale(): void
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
  setLocale(locale?: string): void
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
