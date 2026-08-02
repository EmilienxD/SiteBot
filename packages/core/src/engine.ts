import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
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
import { composePrompt } from './prompt/compose.js'
import type { ProviderFactory } from './providers/adapters.js'
import { runChain } from './providers/fallback.js'
import { resolveChain, resolveModel } from './providers/registry.js'
import { createSessionStore } from './session/factory.js'
import type { SessionStore } from './session/store.js'
import { contextBudget, estimateTokens, truncateHistory } from './session/truncate.js'
import { errorResponse, mapError } from './stream/errors.js'
import { EngineError } from './stream/errors.js'
import { awaitFirstOutput } from './stream/start.js'
import { createEventDispatcher, noopDispatcher, type EventDispatcher } from './telemetry/events.js'
import { createLogger } from './telemetry/logger.js'
import { noopTracer, withSpan, type Tracer } from './telemetry/span.js'
import { createToolRegistry } from './tools/registry.js'
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
    }).build()

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
          tools,
          stopWhen: policy.stopWhen,
          toolChoice: policy.toolChoice,
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

        const stream = await awaitFirstOutput(
          annotateAgentStream(uiStream, { runId, clientTools, config }),
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
      await mcpPool.dispose()
    },
  }

  async function applyResume(
    session: NonNullable<Awaited<ReturnType<SessionStore['get']>>>,
    pending: PendingRun,
    resume: NonNullable<ChatRequest['resume']>,
  ): Promise<typeof session> {
    let responseMessage = structuredClone(pending.responseMessage)
    let nextSession = session

    for (const approval of resume.approvals ?? []) {
      const part = findToolPart(responseMessage, (candidate) =>
        candidate.state === 'approval-requested' && candidate.approval?.id === approval.approvalId,
      )
      if (part === undefined) throw new CheckpointError('Approval replay was rejected.', 403)
      part.state = 'approval-responded'
      part.approval = { ...part.approval, approved: approval.decision === 'approve' }
      if (
        approval.decision === 'approve' &&
        config.agent.approvalPolicy === 'once-per-session'
      ) {
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
  return pending
    ? { runId, responseMessage: message, expiresAt: now + CHECKPOINT_TTL_MS }
    : null
}

function annotateAgentStream(
  stream: ReadableStream<UIMessageChunk>,
  options: {
    runId: string
    clientTools: Set<string>
    config: ResolvedConfig
  },
): ReadableStream<UIMessageChunk> {
  const calls = new Map<string, { toolName: string; input: unknown }>()
  const approvals = new Set<string>()
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
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
              data: { runId: options.runId, toolCallId, ...call },
            } as UIMessageChunk)
          }
        }
        controller.enqueue(chunk)
      },
    }),
  )
}
