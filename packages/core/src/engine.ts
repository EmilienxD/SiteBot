import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  dynamicTool,
  generateId,
  jsonSchema,
  streamText,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { toPublicConfig, type ProviderId, type ResolvedConfig } from '@sitebot/config'
import { resolvePolicy } from './agent/policy.js'
import {
  CHECKPOINT_TTL_MS,
  CheckpointError,
  clearPendingRun,
  grantApproval,
  hasApprovalGrant,
  loadPendingRun,
  savePendingRun,
  type PendingRun,
} from './agent/checkpoint.js'
import { MemoryRateLimitStore, type RateLimitStore } from './guards/rate-limit.js'
import { lastUserMessage, mergeHistory } from './session/history.js'
import { retrieve } from './knowledge/retrieve.js'
import type { KnowledgeDeps, Citation } from './knowledge/types.js'
import { composePrompt, type KnowledgeSnippet } from './prompt/compose.js'
import type { ProviderFactory } from './providers/adapters.js'
import { runChain } from './providers/fallback.js'
import { resolveChain, resolveModel } from './providers/registry.js'
import { createSessionStore } from './session/factory.js'
import type { SessionStore } from './session/store.js'
import { contextBudget, estimateTokens, truncateHistory } from './session/truncate.js'
import defaultPricing from '../pricing.json'
import { usageCost, type PricingTable } from './guards/budget.js'
import { errorResponse, mapError } from './stream/errors.js'
import { EngineError } from './stream/errors.js'
import { awaitFirstOutput } from './stream/start.js'
import { createEventDispatcher, noopDispatcher, type EventDispatcher } from './telemetry/events.js'
import { createLogger } from './telemetry/logger.js'
import { noopTracer, withSpan, type Tracer } from './telemetry/span.js'
import { createToolRegistry, WIDGET_EFFECT, type WidgetEffect } from './tools/registry.js'
import type { HostResolver } from './tools/http.js'
import { McpClientPool, type StdioMcpConnector } from './tools/mcp.js'
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
  resolveHost?: HostResolver
  connectStdioMcp?: StdioMcpConnector
  mcpPool?: McpClientPool
  /**
   * Phase 6: the reachable knowledge index plus the query embedder. Absent
   * (or failed at boot) → `/health` reports the knowledge check as degraded
   * and no knowledge tool is registered, but chat keeps working.
   */
  knowledge?: KnowledgeDeps
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
  const mcpPool =
    deps.mcpPool ??
    new McpClientPool({
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.connectStdioMcp === undefined ? {} : { connectStdio: deps.connectStdioMcp }),
      now,
    })

  const chain = resolveChain(config.backend)
  const debug = config.telemetry.logLevel === 'debug'
  const production =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.NODE_ENV === 'production'
  const errorOptions = { debug, production }

  const knowledgeConfigured =
    config.knowledge.sources.length > 0 && config.knowledge.embedding !== undefined
  // `knowledgeDeps` reads live at request time: the server assembles the store
  // asynchronously (a cold host must not fail to boot on an unreachable
  // index), so the deps object it built the engine with is filled in behind
  // this closure. When knowledge is not configured at all the subsystem is
  // inert regardless.
  const knowledgeDeps: KnowledgeDeps | undefined = knowledgeConfigured
    ? (deps.knowledge ?? {})
    : deps.knowledge

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
    originalMessages: UIMessage[],
    system: string,
    ctx: RequestContext,
    session: Awaited<ReturnType<SessionStore['get']>>,
    resumeRunId?: string,
    activeChain = chain,
    knowledge?: { enabled: boolean; citations: Citation[] },
  ): Promise<{ stream: ReadableStream<UIMessageChunk>; modelId: string }> {
    const policy = resolvePolicy(config)
    const runId = resumeRunId ?? `r_${generateId()}`
    const clientTools = new Set(
      config.tools.flatMap((entry) =>
        !('from' in entry) && entry.executor?.type === 'client' ? [entry.name] : [],
      ),
    )
    const tools = await createToolRegistry({
      config,
      ctx,
      filter: policy.toolFilter,
      approvals: policy.approvals,
      isApprovalGranted: async (toolName, input) =>
        config.agent.approvalPolicy === 'once-per-session'
          ? hasApprovalGrant(session, toolName, input)
          : false,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      baseDir: config.$meta.baseDir,
      ...(deps.resolveHost === undefined ? {} : { resolveHost: deps.resolveHost }),
      mcpPool,
      ...(knowledgeDeps === undefined ? {} : { knowledge: knowledgeDeps }),
      onEvent: async (event, data) => {
        dispatcher.emit(event, data, { requestId: ctx.requestId, sessionId: ctx.sessionId })
        if (event === 'feedback') {
          const hook = config.hooks?.onFeedback as
            ((feedback: Record<string, unknown>) => unknown | Promise<unknown>) | undefined
          if (hook) {
            try {
              await hook(data)
            } catch (error) {
              ctx.logger.error('onFeedback hook threw', { error })
            }
          }
        }
      },
      transcript: originalMessages,
    }).build()
    let finalUsage: { inputTokens: number; outputTokens: number; costUsd: number } | undefined

    // `search_knowledge_base` — the engine-owned side of retrieval mode `tool`
    // and `hybrid`. It exists without a `tools` config entry because the model
    // cannot call what the config does not declare in a chat-mode policy, and
    // the tool policy block must be able to describe it unconditionally.
    if (knowledge?.enabled && policy.retrieval !== 'always') {
      tools['search_knowledge_base'] = dynamicTool({
        description:
          "Search the site's knowledge base for pages relevant to a question. Returns numbered results with [n], title, url and text.",
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for.' },
          },
          required: ['query'],
        } as never),
        execute: async (input: unknown) => {
          if (knowledgeDeps?.store === undefined || knowledgeDeps.embedder === undefined) {
            return { error: 'not_configured' }
          }
          const query =
            typeof input === 'object' && input !== null
              ? String((input as Record<string, unknown>).query ?? '')
              : ''
          if (query === '') return { error: 'invalid_input', issues: ['query is required'] }
          try {
            const result = await retrieve(
              { store: knowledgeDeps.store, embedder: knowledgeDeps.embedder },
              query,
              config,
            )
            knowledge.citations = result.hits.map((hit, index) => ({
              id: `c${index + 1}`,
              title: hit.title,
              url: hit.url,
              snippet: hit.text.slice(0, 280),
              score: hit.score,
            }))
            if (result.hits.length === 0) {
              return {
                results: [],
                note: 'No relevant documentation found. Say so rather than guessing.',
              }
            }
            return {
              results: result.hits.map((hit, index) => ({
                n: index + 1,
                title: hit.title,
                url: hit.url,
                text: hit.text,
                score: hit.score,
              })),
            }
          } catch (error) {
            ctx.logger.warn('knowledge retrieval failed', { error })
            return {
              results: [],
              note: 'Search is temporarily unavailable. Answer from the page context or say you do not know.',
            }
          }
        },
      } as unknown as Parameters<typeof dynamicTool>[0]) as unknown as (typeof tools)[string]
    }

    const result = await runChain({
      entries: activeChain,
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
          tools,
          toolChoice: policy.toolChoice,
          stopWhen: policy.stopWhen,
          ...(policy.summarizeAtStep === undefined
            ? {}
            : {
                prepareStep: ({ stepNumber }: { stepNumber: number }) =>
                  stepNumber >= policy.summarizeAtStep!
                    ? {
                        activeTools: [],
                        toolChoice: 'none' as const,
                        system: `${system}\n\nYou have reached the final step. Summarize the useful results already gathered and answer without calling another tool.`,
                      }
                    : undefined,
              }),
          ...(entry.temperature === undefined ? {} : { temperature: entry.temperature }),
          ...(entry.topP === undefined ? {} : { topP: entry.topP }),
          ...(entry.topK === undefined ? {} : { topK: entry.topK }),
          maxOutputTokens: entry.maxOutputTokens,
          // Retry classification and backoff are ours (docs/04 §3 rules 2–3);
          // letting the SDK retry underneath would double the attempts and
          // retry the errors we deliberately classify as fatal.
          maxRetries: 0,
          abortSignal: ctx.signal,
          experimental_context: ctx,
          experimental_telemetry: {
            isEnabled: config.telemetry.otel.enabled,
            functionId: 'sitebot.run',
          },
          onError: ({ error }) => {
            rawError = error
            ctx.logger.error('model stream error', { error, model: resolved.id })
          },
          onFinish: ({ usage, finishReason }) => {
            finalUsage = {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              costUsd: usageCost(
                {
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  totalTokens: usage.totalTokens ?? 0,
                },
                resolved.id,
                { ...(defaultPricing as PricingTable), ...config.backend.pricing },
              ),
            }
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

        const uiStream = streamed.toUIMessageStream<UIMessage>({
          originalMessages,
          sendReasoning: config.ui.behaviour.showReasoning,
          onError: (error) => mapError(error, errorOptions).message,
        }) as ReadableStream<UIMessageChunk>

        const committed = await awaitFirstOutput(uiStream, { rawError: () => rawError })
        const annotated = annotateAgentStream(committed, {
          runId,
          clientTools,
          config,
          debug,
          status: knowledge?.enabled ? 'Searching documentation…' : undefined,
          usage: () => finalUsage,
        })

        const withCitations =
          knowledge === undefined || knowledge.citations.length === 0
            ? annotated
            : appendCitations(annotated, {
                items: knowledge.citations,
                include: config.knowledge.retrieval.includeCitations,
              })

        const assembled = createUIMessageStream<UIMessage>({
          originalMessages,
          execute: ({ writer }) => writer.merge(withCitations),
          onError: (error) => mapError(error, errorOptions).message,
          onFinish: async ({ responseMessage }) => {
            if (responseMessage.id === '' && responseMessage.parts.length === 0) return
            const current =
              (await sessionStore.get(ctx.sessionId)) ??
              ({
                id: ctx.sessionId,
                messages: [],
                createdAt: now(),
                updatedAt: now(),
              } satisfies NonNullable<typeof session>)
            const messages = replaceOrAppend(current.messages, responseMessage)
            const next = { ...current, messages }
            const pending = pendingRun(responseMessage, runId, now())
            if (pending === null) {
              if (resumeRunId !== undefined) await clearPendingRun(sessionStore, next, resumeRunId)
              else await sessionStore.set(next)
            } else {
              await savePendingRun(sessionStore, next, pending)
            }
          },
        }) as ReadableStream<UIMessageChunk>

        return { stream: assembled, modelId: resolved.id }
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

          // ── knowledge retrieval (docs/06 §3.8) ─────────────────────────
          // Modes: `always`/`hybrid` embed the latest user message and inject
          // hits into the system prompt; `tool`/`hybrid` register
          // `search_knowledge_base`. Degraded knowledge never fails the chat:
          // the block is omitted and the tool absent.
          const knowledgeRequest: { enabled: boolean; citations: Citation[] } = {
            enabled: false,
            citations: [],
          }
          let documents: KnowledgeSnippet[] = []
          let knowledgeNote: string | undefined
          if (
            knowledgeConfigured &&
            knowledgeDeps?.store !== undefined &&
            knowledgeDeps.embedder !== undefined
          ) {
            knowledgeRequest.enabled = true
            if (policy.retrieval !== 'tool' && request.trigger !== 'resume') {
              const latest = lastUserMessage(request.messages)
              const query = latest?.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
              if (query !== undefined && query.trim() !== '') {
                try {
                  const result = await retrieve(
                    { store: knowledgeDeps.store, embedder: knowledgeDeps.embedder },
                    query,
                    config,
                  )
                  documents = result.hits
                  knowledgeRequest.citations = result.hits.map((hit, index) => ({
                    id: `c${index + 1}`,
                    title: hit.title,
                    url: hit.url,
                    snippet: hit.text.slice(0, 280),
                    score: hit.score,
                  }))
                  if (result.hits.length === 0 && result.belowThreshold) {
                    knowledgeNote =
                      'No relevant documentation was found for this question. Say so rather than guessing.'
                  } else if (result.hits.length === 0) {
                    knowledgeNote =
                      'The knowledge base contains no indexed content yet. Answer from what you have.'
                  }
                } catch (error) {
                  ctx.logger.warn('knowledge retrieval failed', { error })
                }
              }
            }
          }

          const composed = composePrompt({
            config,
            ctx: { pageContext: ctx.pageContext, identity: ctx.identity },
            retrieval: policy.retrieval,
            documents,
            note: knowledgeNote,
          })
          if (composed.missingVariables.length > 0) {
            ctx.logger.warn('prompt has unresolved {{variables}}', {
              variables: composed.missingVariables,
            })
          }

          let history: UIMessage[]
          let session = await sessionStore.get(request.sessionId)
          let resumeRunId: string | undefined
          if (request.trigger === 'resume') {
            if (request.resume === undefined) {
              throw new EngineError('invalid_request', { detail: 'resume payload is required' })
            }
            const loaded = await loadPendingRun(
              sessionStore,
              request.sessionId,
              request.resume.runId,
              now(),
            )
            session = await applyResume(loaded.session, loaded.pending, request.resume)
            await sessionStore.set(session)
            history = session.messages
            resumeRunId = request.resume.runId
          } else {
            history = await buildHistory(request)
          }
          const truncated = truncateHistory(history, {
            budgetTokens: contextBudget({
              modelId: `${config.backend.provider}:${config.backend.model}`,
              systemTokens: estimateTokens(composed.text),
              maxOutputTokens: config.backend.maxOutputTokens,
            }),
          })
          const estimatedTokens =
            estimateTokens(composed.text) +
            Math.ceil(JSON.stringify(truncated.messages).length / 4) +
            config.backend.maxOutputTokens
          const budgetDecision = await ctx.budget.check(
            estimatedTokens,
            `${config.backend.provider}:${config.backend.model}`,
          )
          if (budgetDecision === 'block') {
            if (config.security.budget.onExceeded === 'message') {
              return budgetMessageResponse(ctx.requestId)
            }
            throw new EngineError('budget_exceeded')
          }
          const selectedChain =
            budgetDecision === 'degrade' && config.security.budget.degradeTo !== undefined
              ? [config.security.budget.degradeTo]
              : chain
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
            truncated.messages,
            composed.text,
            ctx,
            session,
            resumeRunId,
            selectedChain,
            knowledgeRequest,
          )
          span.setAttribute('sitebot.model', modelId)

          // Persist the user turn only once the model has committed to
          // answering. Storing it before the call would leave an unanswered
          // question in the transcript every time a provider is down, and the
          // next request would replay it as history.
          const latest = request.trigger === 'resume' ? null : lastUserMessage(request.messages)
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

    async bindSessionIdentity(
      sessionId: string,
      token: string | null,
      fingerprint?: string,
    ): Promise<void> {
      if (config.storage.type === 'none') return
      let existing = await sessionStore.get(sessionId)
      const oldHash = existing?.state?.authTokenHash

      if (
        existing?.fingerprint !== undefined &&
        fingerprint !== undefined &&
        existing.fingerprint !== fingerprint
      ) {
        if (typeof oldHash === 'string') await sessionStore.delete(authOwnerKey(oldHash))
        await sessionStore.delete(sessionId)
        existing = null
      }

      if (token === null) {
        if (typeof oldHash === 'string') {
          await sessionStore.delete(authOwnerKey(oldHash))
          await sessionStore.delete(sessionId)
          existing = null
        }
        if (existing === null && fingerprint !== undefined) {
          await sessionStore.set({
            id: sessionId,
            messages: [],
            createdAt: now(),
            updatedAt: now(),
            fingerprint,
          })
        }
        return
      }

      const tokenHash = await hashToken(token)
      const owner = await sessionStore.get(authOwnerKey(tokenHash))
      const ownerSession = owner?.state?.sessionId
      if (typeof ownerSession === 'string' && ownerSession !== sessionId) {
        throw new EngineError('auth_required', {
          detail: 'the verified token is already bound to a different session',
        })
      }
      if (typeof oldHash === 'string' && oldHash !== tokenHash) {
        await sessionStore.delete(authOwnerKey(oldHash))
        await sessionStore.delete(sessionId)
        existing = null
      }
      const session = existing ?? {
        id: sessionId,
        messages: [],
        createdAt: now(),
        updatedAt: now(),
      }
      await sessionStore.set({
        ...session,
        ...(fingerprint === undefined ? {} : { fingerprint }),
        state: { ...(session.state ?? {}), authTokenHash: tokenHash },
      })
      await sessionStore.set({
        id: authOwnerKey(tokenHash),
        messages: [],
        createdAt: now(),
        updatedAt: now(),
        state: { sessionId },
      })
    },

    async getPublicConfig(sessionId?: string) {
      const publicConfig = toPublicConfig(config, {
        ...(options.version === undefined ? {} : { version: options.version }),
      })
      if (sessionId === undefined || config.storage.type === 'none') return publicConfig
      const session = await sessionStore.get(sessionId)
      const pending = session?.state?.pendingRun as PendingRun | undefined
      if (pending === undefined || now() > pending.expiresAt) return publicConfig
      const part = (pending.responseMessage.parts as MutableToolPart[]).find(
        (candidate) =>
          candidate.type.startsWith('tool-') &&
          candidate.state === 'approval-requested' &&
          typeof candidate.approval?.id === 'string',
      )
      if (part === undefined || part.toolCallId === undefined || part.approval?.id === undefined)
        return publicConfig
      const name = toolName(part)
      const entry = config.tools.find(
        (candidate) => !('from' in candidate) && candidate.name === name,
      )
      return {
        ...publicConfig,
        pending: {
          runId: pending.runId,
          approval: {
            approvalId: part.approval.id,
            toolName: name,
            toolCallId: part.toolCallId,
            input: part.input,
            risk: entry && !('from' in entry) ? entry.approvalRisk : 'medium',
            ...(entry && !('from' in entry) && entry.approvalSummary
              ? { description: entry.approvalSummary }
              : {}),
          },
        },
      }
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

      const mcpEntries = config.tools.flatMap((entry) => {
        if (entry.enabled === false) return []
        if ('from' in entry) return [{ id: entry.id, server: entry.server }]
        return entry.executor?.type === 'mcp'
          ? [{ id: `tool:${entry.name}`, server: entry.executor.server }]
          : []
      })
      await Promise.all(
        mcpEntries.map(async ({ id, server }) => {
          const check = await mcpPool.health(id, server)
          checks[`mcp:${id}`] = { ...check }
        }),
      )

      // Knowledge: unreachable store → `degraded`, never `error` — chat keeps
      // working without retrieval (docs/06 §3.7).
      if (knowledgeConfigured) {
        const started = now()
        try {
          if (knowledgeDeps?.store === undefined) {
            throw new EngineError('not_ready', {
              detail: 'knowledge sources are configured but no store is reachable',
            })
          }
          const stats = await knowledgeDeps.store.stats()
          checks.knowledge = {
            status: 'ok',
            latencyMs: now() - started,
            type: config.knowledge.store.type,
            chunks: stats.chunks,
            documents: stats.documents,
            lastIndexed: stats.lastIndexed,
            model: stats.model,
          }
        } catch (error) {
          checks.knowledge = {
            status: 'degraded',
            latencyMs: now() - started,
            error: mapError(error, errorOptions).message,
            type: config.knowledge.store.type,
          }
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
      await knowledgeDeps?.store?.close()
      await mcpPool.dispose()
    },
  }

  function budgetMessageResponse(requestId: string): Response {
    const id = 'budget-message'
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: 'text-start', id })
        writer.write({
          type: 'text-delta',
          id,
          delta: 'The assistant has reached its usage limit for now. Please try again later.',
        })
        writer.write({ type: 'text-end', id })
      },
    })
    return createUIMessageStreamResponse({
      stream,
      headers: { 'x-sitebot-request-id': requestId },
    })
  }

  async function hashToken(token: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  function authOwnerKey(tokenHash: string): string {
    return `sitebot-auth:${tokenHash}`
  }

  async function applyResume(
    session: NonNullable<Awaited<ReturnType<SessionStore['get']>>>,
    pending: PendingRun,
    resume: NonNullable<ChatRequest['resume']>,
  ): Promise<typeof session> {
    let responseMessage = structuredClone(pending.responseMessage)
    let nextSession = session

    for (const approval of resume.approvals ?? []) {
      const part = findToolPart(
        responseMessage,
        (candidate) =>
          candidate.state === 'approval-requested' &&
          candidate.approval?.id === approval.approvalId,
      )
      if (part === undefined) throw new CheckpointError('Approval replay was rejected.', 403)
      part.state = 'approval-responded'
      part.approval = { ...part.approval, approved: approval.decision === 'approve' }
      if (approval.decision === 'approve' && config.agent.approvalPolicy === 'once-per-session') {
        nextSession = await grantApproval(nextSession, toolName(part), part.input)
      }
    }

    for (const result of resume.clientToolResults ?? []) {
      const part = findToolPart(
        responseMessage,
        (candidate) =>
          candidate.toolCallId === result.toolCallId &&
          candidate.state === 'input-available' &&
          isClientTool(toolName(candidate)),
      )
      if (part === undefined) throw new CheckpointError('Client tool replay was rejected.', 403)
      part.state = 'output-available'
      part.output = result.output
    }

    if ((resume.approvals?.length ?? 0) + (resume.clientToolResults?.length ?? 0) === 0) {
      throw new CheckpointError('A resume result is required.', 403)
    }

    responseMessage = { ...responseMessage, parts: responseMessage.parts }
    return {
      ...nextSession,
      messages: replaceOrAppend(nextSession.messages, responseMessage),
      state: { ...nextSession.state, pendingRun: { ...pending, responseMessage } },
    }
  }

  function isClientTool(name: string): boolean {
    return config.tools.some(
      (entry) => !('from' in entry) && entry.name === name && entry.executor?.type === 'client',
    )
  }
}

// ── citations ───────────────────────────────────────────────────────────────

/**
 * Attaches the `data-citations` message part once the assistant text finishes
 * (docs/06 §3.9). The part carries every retrieved chunk; the widget filters
 * to the `[n]` markers actually used in the text, so the UI stays honest.
 */
function appendCitations(
  stream: ReadableStream<UIMessageChunk>,
  options: { items: Citation[]; include: boolean },
): ReadableStream<UIMessageChunk> {
  if (!options.include || options.items.length === 0) return stream
  let textDone = false
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'text-end' && !textDone) {
          textDone = true
          controller.enqueue({
            type: 'data-citations',
            data: { items: options.items },
          } as UIMessageChunk)
        }
        controller.enqueue(chunk)
      },
      flush(controller) {
        // A response with no text part (tool-only) still cites what the tool found.
        if (!textDone) {
          controller.enqueue({
            type: 'data-citations',
            data: { items: options.items },
          } as UIMessageChunk)
        }
      },
    }),
  )
}

type MutableToolPart = {
  type: string
  toolCallId?: string
  state?: string
  input?: unknown
  output?: unknown
  approval?: { id?: string; approved?: boolean }
}

function findToolPart(
  message: UIMessage,
  predicate: (part: MutableToolPart) => boolean,
): MutableToolPart | undefined {
  return (message.parts as MutableToolPart[]).find(
    (part) => part.type.startsWith('tool-') && predicate(part),
  )
}

function toolName(part: MutableToolPart): string {
  return part.type.replace(/^tool-/, '')
}

function replaceOrAppend(messages: UIMessage[], response: UIMessage): UIMessage[] {
  const index = messages.findIndex((message) => message.id === response.id)
  if (index < 0) return [...messages, response]
  const next = [...messages]
  next[index] = response
  return next
}

function pendingRun(message: UIMessage, runId: string, now: number): PendingRun | null {
  const pending = (message.parts as MutableToolPart[]).some(
    (part) =>
      part.type.startsWith('tool-') &&
      (part.state === 'approval-requested' || part.state === 'input-available'),
  )
  return pending ? { runId, responseMessage: message, expiresAt: now + CHECKPOINT_TTL_MS } : null
}

function annotateAgentStream(
  stream: ReadableStream<UIMessageChunk>,
  options: {
    runId: string
    clientTools: Set<string>
    config: ResolvedConfig
    debug: boolean
    status?: string
    usage: () => { inputTokens: number; outputTokens: number; costUsd: number } | undefined
  },
): ReadableStream<UIMessageChunk> {
  const calls = new Map<string, { toolName: string; input: unknown }>()
  const approvals = new Set<string>()
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'start') {
          controller.enqueue(chunk)
          if (options.config.ui.messages.suggestions.length > 0) {
            controller.enqueue({
              type: 'data-suggestions',
              data: { items: options.config.ui.messages.suggestions },
            } as UIMessageChunk)
          }
          if (options.status) {
            controller.enqueue({
              type: 'data-status',
              transient: true,
              data: { text: options.status },
            } as UIMessageChunk)
          }
          return
        }
        if (chunk.type === 'error') {
          controller.enqueue({
            type: 'data-error',
            data: { code: 'provider_error', message: chunk.errorText, retryable: true },
          } as UIMessageChunk)
          return
        }
        if (chunk.type === 'tool-output-available' && isWidgetEffectOutput(chunk.output)) {
          controller.enqueue({
            type: chunk.output[WIDGET_EFFECT].type,
            data: chunk.output[WIDGET_EFFECT].data,
          } as UIMessageChunk)
          chunk = { ...chunk, output: withoutWidgetEffect(chunk.output) }
        }
        if (chunk.type === 'tool-input-available') {
          calls.set(chunk.toolCallId, { toolName: chunk.toolName, input: chunk.input })
        }
        if (chunk.type === 'tool-approval-request') {
          approvals.add(chunk.toolCallId)
          const call = calls.get(chunk.toolCallId)
          const entry = options.config.tools.find(
            (candidate) => !('from' in candidate) && candidate.name === call?.toolName,
          )
          controller.enqueue({
            type: 'data-approval-request',
            data: {
              approvalId: chunk.approvalId,
              runId: options.runId,
              toolCallId: chunk.toolCallId,
              toolName: call?.toolName,
              input: call?.input,
              risk: entry && !('from' in entry) ? entry.approvalRisk : 'medium',
              description: entry && !('from' in entry) ? entry.approvalSummary : undefined,
            },
          } as UIMessageChunk)
        }
        if (chunk.type === 'finish') {
          for (const [toolCallId, call] of calls) {
            if (!options.clientTools.has(call.toolName) || approvals.has(toolCallId)) continue
            controller.enqueue({
              type: 'data-client-tool-call',
              transient: true,
              data: { runId: options.runId, toolCallId, ...call },
            } as UIMessageChunk)
          }
        }
        controller.enqueue(chunk)
      },
      flush(controller) {
        const usage = options.usage()
        if (options.debug && usage) {
          controller.enqueue({
            type: 'data-usage',
            data: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costUsd: usage.costUsd,
            },
          } as UIMessageChunk)
        }
      },
    }),
  )
}

function isWidgetEffectOutput(
  output: unknown,
): output is Record<string, unknown> & { [WIDGET_EFFECT]: WidgetEffect } {
  return (
    typeof output === 'object' &&
    output !== null &&
    WIDGET_EFFECT in output &&
    typeof (output as Record<string, unknown>)[WIDGET_EFFECT] === 'object'
  )
}

function withoutWidgetEffect(output: Record<string, unknown>): Record<string, unknown> {
  const { [WIDGET_EFFECT]: _effect, ...result } = output
  return result
}
