import type { UIMessage } from 'ai'
import type { AuthMode, Mode, PublicConfig, ResolvedConfig } from '@sitebot/config'

/**
 * The cross-cutting types of docs/01-architecture.md §5.
 *
 * Everything here is an interface rather than a class: `RequestContext` is
 * built by the server adapter (layer 3) and consumed by the engine, so the two
 * only ever agree on a shape.
 */

/** Verified claims from the auth JWT. Never model-supplied — docs/08 §3 rule 7. */
export interface Identity {
  sub: string
  email?: string
  [claim: string]: unknown
}

/** What the widget extracts from the host page — docs/03-protocol.md §10. */
export interface PageContext {
  url?: string
  path?: string
  title?: string
  description?: string
  locale?: string
  referrer?: string
  selection?: string | null
  extract?: string
  /** Sent instead of `extract` when the page has not changed (docs/03 §10). */
  extractHash?: string
  meta?: Record<string, string>
  custom?: Record<string, unknown>
}

/** The body of `POST /api/chat` — docs/03-protocol.md §2. */
export interface ChatRequest {
  sessionId: string
  messages: UIMessage[]
  pageContext?: PageContext | null
  auth?: string
  trigger?: 'submit-message' | 'regenerate' | 'resume'
  /** Populated in Phase 5; declared here so the type does not churn later. */
  resume?: ResumeRequest
}

export interface ResumeRequest {
  runId: string
  approvals?: Array<{ approvalId: string; decision: 'approve' | 'deny' }>
  clientToolResults?: Array<{ toolCallId: string; output: unknown }>
}

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

export interface Logger {
  level: LogLevel
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  /** Derive a logger that stamps `fields` onto every record. */
  child(fields: Record<string, unknown>): Logger
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * docs/04-providers-and-engine.md §8. Fully enforced in Phase 8; the interface
 * exists now because `RequestContext` carries it and tool executors will read
 * it in Phase 5.
 */
export interface BudgetTracker {
  session: { tokens: number; usd: number }
  day: { tokens: number; usd: number }
  toolCalls(name?: string): Promise<number>
  check(estimateTokens: number): 'ok' | 'degrade' | 'block'
  record(usage: TokenUsage, modelId: string): Promise<void>
}

/** docs/01-architecture.md §5. What every layer, and every tool, receives. */
export interface RequestContext {
  requestId: string
  sessionId: string
  identity: Identity | null
  pageContext: PageContext | null
  origin: string
  locale: string
  ip: string | null
  signal: AbortSignal
  logger: Logger
  budget: BudgetTracker
}

export type HealthStatus = 'ok' | 'degraded' | 'error'

/** docs/03-protocol.md §8. */
export interface HealthReport {
  status: HealthStatus
  version?: string
  config: { valid: boolean; mode: Mode; toolCount: number }
  checks: Record<
    string,
    { status: HealthStatus; latencyMs?: number; error?: string } & {
      [extra: string]: unknown
    }
  >
}

export interface Engine {
  handleChat(req: ChatRequest, ctx: RequestContext): Promise<Response>
  getPublicConfig(): PublicConfig
  health(): Promise<HealthReport>
  dispose(): Promise<void>
}

export interface EngineOptions {
  /** Reported to the widget and in `/health`. */
  version?: string
}

export type { AuthMode, Mode, PublicConfig, ResolvedConfig }
