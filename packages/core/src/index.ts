/**
 * @sitebot/core — layer 2. The engine.
 *
 * No HTTP framework dependency, and no `node:*` imports in this entry — it must
 * build for Cloudflare Workers, Vercel Edge and Deno. Node-only pieces (stdio
 * MCP transport, fs-backed stores) live behind `@sitebot/core/node`.
 *
 * Implemented across Phases 2, 5 and 6 — see docs/04-providers-and-engine.md.
 */

export const ENGINE_PROTOCOL_VERSION = 'v1' as const

/** The two policy modes. One engine; `mode` is the only switch. docs/02 §7. */
export const MODES = ['chat', 'agent'] as const
export type Mode = (typeof MODES)[number]

/** Tool executor kinds. docs/00-overview.md D8, docs/05-tools.md. */
export const EXECUTOR_KINDS = ['http', 'mcp', 'module', 'builtin', 'client'] as const
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number]

// ── the engine ──────────────────────────────────────────────────────────────

export { createEngine, HEALTH_CACHE_MS } from './engine.js'
export type { EngineDeps } from './engine.js'

export { resolvePolicy, tokenBudgetIs, wallClockIs } from './agent/policy.js'
export type { Policy } from './agent/policy.js'

// ── guards ──────────────────────────────────────────────────────────────────
// Exported in full because @sitebot/server runs them: the adapter is what
// builds `RequestContext`, and identity is a guard output (docs/01 §5).

export * from './guards/index.js'

// ── providers ───────────────────────────────────────────────────────────────

export { ADAPTERS } from './providers/adapters.js'
export type { ProviderFactory } from './providers/adapters.js'
export {
  backoffDelay,
  classifyError,
  FATAL_STATUSES,
  RETRYABLE_STATUSES,
  runChain,
} from './providers/fallback.js'
export type {
  ChainResult,
  Classification,
  FallbackEvent,
  RunChainOptions,
} from './providers/fallback.js'
export { BACKEND_ENTRY_DEFAULTS, resolveChain, resolveModel } from './providers/registry.js'
export type { ResolvedModel } from './providers/registry.js'
export {
  importProviderPackage,
  installHint,
  isModuleNotFound,
  readEnv,
} from './providers/optional-import.js'

// ── prompt ──────────────────────────────────────────────────────────────────

export { composePrompt } from './prompt/compose.js'
export type {
  ComposeContext,
  ComposeInput,
  ComposedPrompt,
  KnowledgeSnippet,
} from './prompt/compose.js'
export {
  DELIMITER_PATTERN,
  randomDelimiterId,
  stripDelimiters,
  untrustedBlock,
} from './prompt/untrusted.js'
export { substituteVariables } from './prompt/variables.js'

// ── session ─────────────────────────────────────────────────────────────────

export { createSessionStore } from './session/factory.js'
export { lastUserMessage, mergeHistory } from './session/history.js'
export type { MergeHistoryInput } from './session/history.js'
export { MemorySessionStore, NoneSessionStore } from './session/store.js'
export type { SessionStore, SessionStoreOptions, StoredSession } from './session/store.js'
export {
  contextBudget,
  DEFAULT_CONTEXT_WINDOW,
  estimateMessageTokens,
  estimateTokens,
  maxContextTokens,
  truncateHistory,
} from './session/truncate.js'
export type { ContextBudgetInput, TruncateOptions, TruncateResult } from './session/truncate.js'

// ── knowledge ───────────────────────────────────────────────────────────────

export { MemoryVectorStore } from './knowledge/memory-store.js'
export { cosineSimilarity, matchesFilter } from './knowledge/store.js'
export type {
  Chunk,
  ChunkMetadata,
  QueryOptions,
  ScoredChunk,
  StoreMeta,
  VectorStore,
  VectorStoreStats,
} from './knowledge/store.js'
export { finalize, retrieve } from './knowledge/retrieve.js'
export { knowledgeEnabled } from './knowledge/types.js'
export type {
  Citation,
  CitationsPayload,
  KnowledgeDeps,
  QueryEmbedder,
  RetrievalHit,
  RetrievalResult,
} from './knowledge/types.js'

// ── stream ──────────────────────────────────────────────────────────────────

export { EngineError, ERROR_CODES, ERROR_TABLE, errorResponse, mapError } from './stream/errors.js'
export type { ErrorCode, ErrorSpec, MapErrorOptions, MappedError } from './stream/errors.js'
export { awaitFirstOutput, EmptyStreamError, StreamStartError } from './stream/start.js'

export { createToolRegistry } from './tools/registry.js'
export { createHttpExecutor } from './tools/http.js'
export type { HostResolver } from './tools/http.js'
export { validateJsonSchema } from './tools/schema.js'
export type { ToolRegistry, ToolRegistryOptions } from './tools/registry.js'
export type { JsonSchemaObject, SchemaIssue, SchemaResult } from './tools/schema.js'
export { ApprovalError, MemoryApprovalStore, argumentHash } from './tools/approvals.js'
export type { ApprovalCheckpoint, ApprovalDecision, ApprovalResolution } from './tools/approvals.js'
export { lintTools } from './tools/lint.js'
export type { ToolLintFinding, ToolLintSeverity } from './tools/lint.js'
export { McpClientPool } from './tools/mcp.js'
export type {
  McpClientPoolOptions,
  McpConnection,
  McpConnector,
  McpHealthCheck,
  McpServer,
  StdioMcpConnector,
  StdioServer,
} from './tools/mcp.js'

// ── telemetry ───────────────────────────────────────────────────────────────

export { createEventDispatcher, noopDispatcher } from './telemetry/events.js'
export type { EventDispatcher, EventName, TelemetryEvent } from './telemetry/events.js'
export { createLogger, redact, redactString, silentLogger } from './telemetry/logger.js'
export type { LoggerOptions, LogRecord } from './telemetry/logger.js'
export { createRecordingTracer, noopTracer, withSpan } from './telemetry/span.js'
export type { Span, Tracer } from './telemetry/span.js'

// ── types ───────────────────────────────────────────────────────────────────

export type {
  AuthMode,
  BudgetTracker,
  ChatRequest,
  Engine,
  EngineOptions,
  HealthReport,
  HealthStatus,
  Identity,
  LogLevel,
  Logger,
  PageContext,
  PublicConfig,
  RequestContext,
  ResumeRequest,
  ResolvedConfig,
  TokenUsage,
} from './types.js'
