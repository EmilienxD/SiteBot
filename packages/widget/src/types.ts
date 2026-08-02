import type { PublicConfig, Ui } from '@sitebot/config'
import type { UIMessage } from 'ai'

export type WidgetState = 'idle' | 'submitted' | 'streaming' | 'awaiting-approval' | 'error'
export interface SiteBotOptions { endpoint?: string; publicKey?: string; autoOpen?: boolean; position?: Ui['position']; theme?: Ui['theme']['mode']; nonce?: string; onEvent?: (event: SiteBotEvent) => void }
export interface SiteBotEvent { type: 'open' | 'close' | 'message' | 'tool' | 'approval' | 'error' | 'reset'; detail?: unknown }
export interface PageContext { url: string; path: string; title: string; description: string; locale: string; referrer: string; selection: string | null; extract?: string; extractHash?: string; meta: Record<string, string> }
export interface WidgetController {
  options: Required<Pick<SiteBotOptions, 'endpoint' | 'publicKey'>> & SiteBotOptions
  config: PublicConfig
  readonly messages: UIMessage[]
  readonly state: WidgetState
  readonly error?: Error
  open(): void; close(): void; toggle(): void; send(text: string): Promise<void>; stop(): void; reset(): void; identify(jwt: string | null): void; refreshPageContext(): Promise<PageContext | null>; registerTool(name: string, handler: (input: unknown) => unknown | Promise<unknown>): void; unregisterTool(name: string): void; approve(approvalId: string, approved: boolean): Promise<void>; subscribe(listener: () => void): () => void
}
export interface SiteBotApi { open(): void; close(): void; toggle(): void; send(text: string): void; identify(jwt: string): void; reset(): void; refreshPageContext(): void; registerTool(name: string, fn: (input: unknown) => unknown | Promise<unknown>): void; unregisterTool(name: string): void; on(event: SiteBotEvent['type'], listener: (detail?: unknown) => void): () => void }
declare global { interface Window { SiteBot?: SiteBotApi; SiteBotConfig?: SiteBotOptions } }
