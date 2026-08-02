import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { toPublicConfig, type ProviderId, type ResolvedConfig } from '@sitebot/config'
import { resolvePolicy } from './agent/policy.js'
import { MemoryRateLimitStore, type RateLimitStore } from './guards/rate-limit.js'
import { lastUserMessage, mergeHistory } from './session/history.js'
import { composePrompt } from './prompt/compose.js'
import type { ProviderFactory } from './providers/adapters.js'
import { runChain } from './providers/fallback.js'
import { resolveChain, resolveModel } from './providers/registry.js'
import { createSessionStore } from './session/factory.js'
import type { SessionStore } from './session/store.js'
import { contextBudget, estimateTokens, truncateHistory } from './session/truncate.js'
import { errorResponse, mapError } from './stream/errors.js'
import { awaitFirstOutput } from './stream/start.js'
import { createEventDispatcher, noopDispatcher, type EventDispatcher } from './telemetry/events.js'
import { createLogger } from './telemetry/logger.js'
import { noopTracer, withSpan, type Tracer } from './telemetry/span.js'
import type {
  ChatRequest,
  Engine,
  EngineOptions,
  HealthReport,
  HealthStatus,
  Logger,
  RequestContext,
} from './types.js'

/**
 * The engine — docs/01-architecture.md §2, docs/04-providers-and-engine.md §4.
 *
 * Phase 2 scope: chat mode, no tools, no knowledge. The seams for both are cut
 * (`policy.toolFilter`, `composePrompt`'s `documents`), so Phases 5 and 6 add
 * capability without reshaping this file.
 *
 * Everything external is injectable. That is not test-scaffolding for its own
 * sake — it is what lets `@sitebot/core` claim to be edge-compatible while
 * still supporting sqlite sessions and Redis rate limits: the Node-only
 * constructors live in `@sitebot/core/node` and arrive through `deps`.
 */

export interface EngineDeps {
  sessionStore?: SessionStore
  rateLimitStore?: RateLimitStore
  logger?: Logger
  tracer?: Tracer
  dispatcher?: EventDispatcher
  /** Overrides the provider adapter table. Tests inject stubs; nothing else. */
  adapters?: Partial<Record<ProviderId, ProviderFactory>>
  /** Injected so telemetry delivery never touches the real network in tests. */
  fetchImpl?: typeof fetch
  now?: () => number
}

/** How long a `/health` provider check is reused — docs/03-protocol.md §8. */
export const HEALTH_CACHE_MS = 30_000

interface ProviderCheck {
  status: HealthStatus
  latencyMs: number
  error?: string
  at: number
}

export function createEngine(
  config: ResolvedConfig,
  deps: EngineDeps = {},
  options: EngineOptions = {},
): Engine {
  const logger =
    deps.logger ??
    createLogger({
      level: config.telemetry.logLevel,
      redactPrompts: config.telemetry.redactPromptsInLogs,
    })
  const tracer = deps.tracer ?? noopTracer
  const now = deps.now ?? (() => Date.now())

  const sessionStore = deps.sessionStore ?? createSessionStore(config.storage)
  const rateLimitStore = deps.rateLimitStore ?? new MemoryRateLimitStore({ now })
  const dispatcher =
    deps.dispatcher ??
    (config.telemetry.enabled && config.telemetry.events.webhook !== undefined
      ? createEventDispatcher({
          telemetry: config.telemetry,
          logger,
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          now,
        })
      : noopDispatcher)

  const chain = resolveChain(config.backend)
  const debug = config.telemetry.logLevel === 'debug'
  const production =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.NODE_ENV === 'production'
  const errorOptions = { debug, production }

  let providerCheck: ProviderCheck | undefined

  // ── history ───────────────────────────────────────────────────────────────

  /** docs/04 §6 steps 1–2 and docs/08 §6. `mergeHistory` owns the trust rule. */
  async function buildHistory(request: ChatRequest): Promise<UIMessage[]> {
    const stateless = config.storage.type === 'none'
    const stored = stateless ? null : await sessionStore.get(request.sessionId)
    return mergeHistory({
      stored: stored?.messages ?? [],
      incoming: request.messages,
      stateless,
    })
  }

  // ── the model call ────────────────────────────────────────────────────────

  async function startStream(
    messages: ModelMessage[],
    system: string,
    ctx: RequestContext,
  ): Promise<{ stream: ReadableStream<UIMessageChunk>; modelId: string }> {
    const policy = resolvePolicy(config)

    const result = await runChain({
      entries: chain,
      onFallback: (event) => {
        // Silent degradation is a bug — docs/04 §3 rule 6.
        ctx.logger.warn('provider fallback', { ...event })
        dispatcher.emit(
          'provider_fallback',
          { ...event },
          {
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
          },
        )
      },
      attempt: async (entry) => {
        const resolved = await resolveModel(entry, {
          ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
        })

        // The chunk stream only carries a redacted string; `classifyError`
        // needs the status code, so the raw error is captured here.
        let rawError: unknown

        const streamed = streamText({
          model: resolved.model,
          system,
          messages,
          stopWhen: policy.stopWhen,
          toolChoice: 'none',
          ...(entry.temperature === undefined ? {} : { temperature: entry.temperature }),
          ...(entry.topP === undefined ? {} : { topP: entry.topP }),
          ...(entry.topK === undefined ? {} : { topK: entry.topK }),
          maxOutputTokens: entry.maxOutputTokens,
          // Retry classification and backoff are ours (docs/04 §3 rules 2–3);
          // letting the SDK retry underneath would double the attempts and
          // retry the errors we deliberately classify as fatal.
          maxRetries: 0,
          abortSignal: ctx.signal,
          experimental_telemetry: {
            isEnabled: config.telemetry.otel.enabled,
            functionId: 'sitebot.run',
          },
          onError: ({ error }) => {
            rawError = error
            ctx.logger.error('model stream error', { error, model: resolved.id })
          },
          onFinish: ({ usage, finishReason }) => {
            void ctx.budget.record(
              {
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                totalTokens: usage.totalTokens ?? 0,
              },
              resolved.id,
            )
            dispatcher.emit(
              'finish',
              { model: resolved.id, finishReason, usage },
              { requestId: ctx.requestId, sessionId: ctx.sessionId },
            )
          },
        })

        const stream = await awaitFirstOutput(
          streamed.toUIMessageStream({
            sendReasoning: config.ui.behaviour.showReasoning,
            onError: (error) => mapError(error, errorOptions).message,
          }) as ReadableStream<UIMessageChunk>,
          { rawError: () => rawError },
        )

        return { stream, modelId: resolved.id }
      },
    })

    return result.value
  }

  // ── the Engine surface ────────────────────────────────────────────────────

  return {
    async handleChat(request: ChatRequest, ctx: RequestContext): Promise<Response> {
      try {
        return await withSpan(tracer, 'sitebot.handleChat', async (span) => {
          span.setAttribute('sitebot.mode', config.mode)
          span.setAttribute('sitebot.session_id', ctx.sessionId)

          const policy = resolvePolicy(config)

          const composed = composePrompt({
            config,
            ctx: { pageContext: ctx.pageContext, identity: ctx.identity },
            retrieval: policy.retrieval,
          })
          if (composed.missingVariables.length > 0) {
            ctx.logger.warn('prompt has unresolved {{variables}}', {
              variables: composed.missingVariables,
            })
          }

          const history = await buildHistory(request)
          const truncated = truncateHistory(history, {
            budgetTokens: contextBudget({
              modelId: `${config.backend.provider}:${config.backend.model}`,
              systemTokens: estimateTokens(composed.text),
              maxOutputTokens: config.backend.maxOutputTokens,
            }),
          })
          if (truncated.dropped > 0) {
            ctx.logger.debug('history truncated', {
              dropped: truncated.dropped,
              kept: truncated.messages.length,
            })
          }

          dispatcher.emit(
            'message',
            { role: 'user', messageCount: truncated.messages.length },
            { requestId: ctx.requestId, sessionId: ctx.sessionId },
          )

          const { stream, modelId } = await startStream(
            await convertToModelMessages(truncated.messages),
            composed.text,
            ctx,
          )
          span.setAttribute('sitebot.model', modelId)

          // Persist the user turn only once the model has committed to
          // answering. Storing it before the call would leave an unanswered
          // question in the transcript every time a provider is down, and the
          // next request would replay it as history.
          const latest = lastUserMessage(request.messages)
          if (config.storage.type !== 'none' && latest !== null) {
            await sessionStore.append(request.sessionId, [latest])
          }

          return createUIMessageStreamResponse({
            stream,
            headers: { 'x-sitebot-request-id': ctx.requestId },
          })
        })
      } catch (error) {
        ctx.logger.error('chat request failed', { error })
        dispatcher.emit(
          'error',
          { code: mapError(error, errorOptions).code },
          { requestId: ctx.requestId, sessionId: ctx.sessionId },
        )
        return errorResponse(error, errorOptions)
      }
    },

    getPublicConfig() {
      return toPublicConfig(config, {
        ...(options.version === undefined ? {} : { version: options.version }),
      })
    },

    async health(): Promise<HealthReport> {
      const checks: HealthReport['checks'] = {}

      // Provider checks are cached for 30 s so that a monitoring endpoint
      // polled every second cannot become its own outage (docs/03 §8).
      const cached = providerCheck
      if (cached !== undefined && now() - cached.at < HEALTH_CACHE_MS) {
        checks.provider = {
          status: cached.status,
          latencyMs: cached.latencyMs,
          ...(cached.error === undefined ? {} : { error: cached.error }),
          cached: true,
        }
      } else {
        const started = now()
        try {
          const resolved = await resolveModel(chain[0] as (typeof chain)[number], {
            ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
          })
          providerCheck = { status: 'ok', latencyMs: now() - started, at: now() }
          checks.provider = {
            status: 'ok',
            latencyMs: providerCheck.latencyMs,
            model: resolved.id,
            // Named explicitly: this is the cost of resolving the provider SDK
            // and constructing the model, not a round-trip to the provider. A
            // health check that spent a token per poll would be its own bill.
            probe: 'resolve',
          }
        } catch (error) {
          const mapped = mapError(error, errorOptions)
          providerCheck = {
            status: 'error',
            latencyMs: now() - started,
            error: mapped.message,
            at: now(),
          }
          checks.provider = {
            status: 'error',
            latencyMs: providerCheck.latencyMs,
            error: mapped.message,
          }
        }
      }

      try {
        await sessionStore.get('health-probe')
        checks.storage = { status: 'ok', type: config.storage.type }
      } catch (error) {
        checks.storage = {
          status: 'error',
          error: mapError(error, errorOptions).message,
          type: config.storage.type,
        }
      }

      // `error` when the provider or storage is unusable, `degraded` when
      // something non-essential is (knowledge and MCP, from Phases 6 and 7).
      const statuses = Object.values(checks).map((check) => check.status)
      const status: HealthStatus = statuses.includes('error')
        ? 'error'
        : statuses.includes('degraded')
          ? 'degraded'
          : 'ok'

      return {
        status,
        ...(options.version === undefined ? {} : { version: options.version }),
        config: { valid: true, mode: config.mode, toolCount: config.tools.length },
        checks,
      }
    },

    async dispose(): Promise<void> {
      await dispatcher.drain()
      await sessionStore.dispose?.()
      await rateLimitStore.dispose?.()
    },
  }
}
