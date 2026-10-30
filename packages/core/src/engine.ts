import { createTranslator, localeTables, resolveLocale } from '@sitebot/config/i18n'
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  generateText,
  streamText,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import {
  ConfigValidationError,
  compileToolSchema,
  isToolEnabled,
  toPublicConfig,
  type ProviderId,
  type ResolvedConfig,
} from '@sitebot/config'
import { resolvePolicy } from './agent/policy.js'
import {
  CHECKPOINT_TTL_MS,
  abandonPendingRun,
  CheckpointError,
  clearPendingRun,
  grantApproval,
  hasApprovalGrant,
  hasPendingRun,
  loadPendingRun,
  savePendingRun,
  type PendingRun,
} from './agent/checkpoint.js'
import { MemoryRateLimitStore, type RateLimitStore } from './guards/rate-limit.js'
import { lastUserMessage, mergeHistory, settleDanglingToolCalls } from './session/history.js'
import { SourceEvidence } from './sources/evidence.js'
import { appendCitations } from './sources/stream.js'
import { composePrompt, type ComposedPrompt } from './prompt/compose.js'
import { cachedSystem } from './prompt/cache.js'
import type { ProviderFactory } from './providers/adapters.js'
import { runChain } from './providers/fallback.js'
import { resolveChain, resolveModel } from './providers/registry.js'
import { withModelTimeout } from './providers/timeout.js'
import { createSessionStore } from './session/factory.js'
import type { SessionStore } from './session/store.js'
import { contextBudget, estimateTokens, truncateHistory } from './session/truncate.js'
import defaultPricing from '../pricing.json'
import { usageCost, validateBudgetPricing, type PricingTable } from './guards/budget.js'
import { errorResponse, mapError } from './stream/errors.js'
import { EngineError } from './stream/errors.js'
import { awaitFirstOutput } from './stream/start.js'
import { ensureTerminalOutcome, type LoopStopReason } from './stream/terminal.js'
import { createEventDispatcher, noopDispatcher, type EventDispatcher } from './telemetry/events.js'
import { createLogger } from './telemetry/logger.js'
import { hooksOf, reportError, runHook } from './hooks.js'
import { withDeadline, checkDeadline } from './deadline.js'
import { resolveSystem } from './prompt/resolve.js'
import { snapshotToolValue } from './tools/schema.js'
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
 * Application tools, instructions and providers are explicitly configured.
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
  const pricingErrors = validateBudgetPricing(config)
  if (pricingErrors.length > 0) throw new ConfigValidationError(pricingErrors)

  const logger =
    deps.logger ??
    createLogger({
      level: config.telemetry.logLevel,
      redactPrompts: config.telemetry.redactPromptsInLogs,
    })
  const tracer = deps.tracer ?? noopTracer
  const now = deps.now ?? (() => Date.now())

  const sessionStore = deps.sessionStore ?? createSessionStore(config.storage)
  if (
    config.tools.some((entry) => entry.maxCallsPerSession !== undefined) &&
    sessionStore.claimToolCall === undefined
  )
    throw new EngineError('not_ready')
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
  const hooks = hooksOf(config)
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
    evidence: SourceEvidence,
    ctx: RequestContext,
    session: Awaited<ReturnType<SessionStore['get']>>,
    resumeRunId?: string,
    activeChain = chain,
    composed?: ComposedPrompt,
    progress: { stepsTaken?: number; tokensUsed?: number; activeMs?: number } = {},
  ): Promise<{ stream: ReadableStream<UIMessageChunk>; modelId: string }> {
    const startedAt = now()
    const policy = resolvePolicy(config, { ...progress, now })
    const runId = resumeRunId ?? `r_${generateId()}`
    const clientTools = new Set(
      config.tools.flatMap((entry) => (entry.executor?.type === 'client' ? [entry.name] : [])),
    )
    let stepToolsEnabled = policy.toolChoice !== 'none'
    const consumedApprovals = new Set<string>()
    let attemptTools = new AbortController()
    let attemptToolSignal = ctx.signal
    const toolContext: RequestContext = {
      ...ctx,
      get signal() {
        return attemptToolSignal
      },
    }
    const tools = await createToolRegistry({
      config,
      ctx: toolContext,
      filter: policy.toolFilter,
      canExecute: () => stepToolsEnabled,
      approvals: policy.approvals,
      ...(sessionStore.claimToolCall === undefined
        ? {}
        : {
            claimToolCall: (name: string, limit: number) =>
              sessionStore.claimToolCall!(ctx.sessionId, name, limit),
          }),
      isCallApproved: (name, input, callId) => {
        if (callId === undefined || consumedApprovals.has(callId)) return false
        const pending = session?.state?.pendingRun as PendingRun | undefined
        const approved =
          pending?.responseMessage.parts.some((part) => {
            const candidate = part as MutableToolPart
            return (
              candidate.type === `tool-${name}` &&
              candidate.toolCallId === callId &&
              candidate.state === 'approval-responded' &&
              candidate.approval?.approved === true &&
              JSON.stringify(candidate.input) === JSON.stringify(input)
            )
          }) ?? false
        if (approved) consumedApprovals.add(callId)
        return approved
      },
      isApprovalGranted: async (toolName, input) =>
        config.agent.approvalPolicy === 'once-per-session'
          ? hasApprovalGrant(session, toolName, input)
          : false,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      baseDir: config.$meta.baseDir,
      ...(deps.resolveHost === undefined ? {} : { resolveHost: deps.resolveHost }),
      mcpPool,
      sourceEvidence: evidence,
      onToolCall: async (call, callCtx) => hooks.onToolCall?.(call, callCtx),
    }).build()
    let finalUsage: { inputTokens: number; outputTokens: number; costUsd: number } | undefined
    let totalTokens = 0
    let completedSteps = 0
    let stepTokens = 0
    let loopStop: LoopStopReason | undefined

    // Do not rely on a provider honoring `tool_choice: none` to suppress
    // execution. In particular, some compatible local endpoints ignore it.
    const callableTools =
      policy.toolChoice === 'none' ? (Object.create(null) as typeof tools) : tools
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
        if (ctx.signal.aborted) throw new DOMException('Request cancelled.', 'AbortError')
        attemptTools = new AbortController()
        attemptToolSignal = AbortSignal.any([ctx.signal, attemptTools.signal])
        const toolsForAttempt = attemptTools
        const resolved = await resolveModel(entry, {
          ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
          baseDir: config.$meta.baseDir,
        })

        // The chunk stream only carries a redacted string; `classifyError`
        // needs the status code, so the raw error is captured here.
        let rawError: unknown
        // Before the first token, a failure is the chain's to retry or hop, and
        // only a request that fails outright reaches `onError` (from the
        // catch in handleChat). After it, the error is the visitor's.
        let outputCommitted = false
        let terminalFailure = false

        const streamed = streamText({
          model: withModelTimeout(resolved.model, entry.timeoutMs, () =>
            toolsForAttempt.abort(new Error('Provider deadline exceeded.')),
          ),
          system: cachedSystem(entry.provider, system, composed),
          messages,
          tools: callableTools,
          toolChoice: Object.keys(callableTools).length > 0 ? policy.toolChoice : 'none',
          stopWhen: async (state) => {
            // A timed-out provider can still have emitted a tool call. Its
            // aborted tool result must not start a fresh model step.
            if (toolsForAttempt.signal.aborted) return true
            const stops = await Promise.all(policy.stopWhen.map((condition) => condition(state)))
            // Preserve the exact OR policy and record which hard boundary ended the loop.
            loopStop = stops[1] ? 'tokens' : stops[2] ? 'time' : stops[0] ? 'steps' : undefined
            return stops.some(Boolean)
          },
          ...(policy.summarizeAtStep === undefined
            ? {}
            : {
                prepareStep: ({ stepNumber }: { stepNumber: number }) => {
                  stepToolsEnabled = stepNumber < policy.summarizeAtStep!
                  return !stepToolsEnabled
                    ? {
                        // Google/Vertex omit native functionCallingConfig.NONE
                        // when declarations are empty. Retain only this request's
                        // eligible application schemas; toolChoice and the
                        // independent canExecute guard still prohibit calls.
                        activeTools:
                          entry.provider === 'google' || entry.provider === 'vertex'
                            ? Object.keys(callableTools)
                            : [],
                        toolChoice: 'none' as const,
                        system: (() => {
                          const cached = cachedSystem(entry.provider, system, composed)
                          const instruction =
                            'You have reached the final step. Answer from the evidence already gathered without calling another tool. Cite only sources that support your claims; if evidence is insufficient, say so plainly. Keep the response in the requested language.'
                          return typeof cached === 'string'
                            ? `${cached}\n\n${instruction}`
                            : [...cached, { role: 'system' as const, content: instruction }]
                        })(),
                      }
                    : undefined
                },
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
            if (outputCommitted) reportError(hooks, error, ctx)
          },
          onStepFinish: (step) => {
            completedSteps += 1
            stepTokens +=
              step.usage.totalTokens ??
              (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0)
            void runHook(
              hooks,
              'onStep',
              ctx,
              {
                finishReason: step.finishReason,
                rawFinishReason: step.rawFinishReason,
                text: step.text,
                toolCalls: step.toolCalls.map((call) => ({
                  name: call.toolName,
                  input: call.input,
                })),
                usage: {
                  inputTokens: step.usage.inputTokens ?? 0,
                  outputTokens: step.usage.outputTokens ?? 0,
                },
              },
              ctx,
            )
          },
          // `totalUsage`, not `usage`: the latter is the last step only, and a
          // multi-step agent run would be billed — and budgeted — for one step.
          onFinish: async ({ totalUsage: usage, finishReason }) => {
            totalTokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
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
            await ctx.budget.record(
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
            void runHook(
              hooks,
              'onFinish',
              ctx,
              {
                model: resolved.id,
                finishReason,
                usage: finalUsage,
              },
              ctx,
            )
          },
        })

        const uiStream = streamed.toUIMessageStream<UIMessage>({
          originalMessages,
          sendReasoning: config.ui.behaviour.showReasoning,
          onError: (error) =>
            mapError(
              error instanceof Error && error.name === 'TimeoutError'
                ? new EngineError('provider_error')
                : error,
              { ...errorOptions, locale: ctx.locale, localization: config.ui },
            ).message,
        }) as ReadableStream<UIMessageChunk>

        const committed = await awaitFirstOutput(uiStream, { rawError: () => rawError })
        outputCommitted = true
        const annotated = annotateAgentStream(committed, {
          runId,
          clientTools,
          config,
          authorizeClient: (name, input) => {
            if (!stepToolsEnabled) throw new CheckpointError('Tool is no longer authorized.', 403)
            return authorizeTool(name, input, ctx, false, true)
          },
          locale: ctx.locale,
          debug,
          usage: () => finalUsage,
        })

        const terminal = ensureTerminalOutcome(annotated, {
          signal: ctx.signal,
          stopReason: () => loopStop,
          onMaxSteps: config.agent.onMaxSteps,
          errors: { ...errorOptions, locale: ctx.locale, localization: config.ui },
          priorAnswerCharacters: answerCharacters(originalMessages.at(-1)),
          onComplete: (outcome) => {
            terminalFailure = outcome.failed
            if (terminalFailure) toolsForAttempt.abort(new Error('Model turn ended.'))
            if (terminalFailure)
              ctx.logger.error('model loop failed', {
                ...outcome,
                requestId: ctx.requestId,
                stopReason: loopStop ?? 'provider',
                steps: (progress.stepsTaken ?? 0) + completedSteps,
              })
            ctx.logger.debug('model loop finalized', {
              ...outcome,
              requestId: ctx.requestId,
              stopReason: loopStop ?? 'provider',
              steps: (progress.stepsTaken ?? 0) + completedSteps,
              stepsThisRequest: completedSteps,
              totalTokens: (progress.tokensUsed ?? 0) + stepTokens,
              activeMs: (progress.activeMs ?? 0) + Math.max(0, now() - startedAt),
            })
          },
        })
        const withCitations = appendCitations(terminal, {
          items: () => evidence.citations,
          include: true,
        })

        const assembled = createUIMessageStream<UIMessage>({
          originalMessages,
          execute: ({ writer }) => writer.merge(withCitations),
          onError: (error) =>
            mapError(error, { ...errorOptions, locale: ctx.locale, localization: config.ui })
              .message,
          onFinish: async ({ responseMessage }) => {
            if (responseMessage.id === '' && responseMessage.parts.length === 0) return
            if (terminalFailure)
              responseMessage = settleDanglingToolCalls([responseMessage]).messages[0]!
            const current =
              (await sessionStore.get(ctx.sessionId)) ??
              ({
                id: ctx.sessionId,
                messages: [],
                createdAt: now(),
                updatedAt: now(),
              } satisfies NonNullable<typeof session>)
            const messages = replaceOrAppend(current.messages, responseMessage)
            const next = {
              ...current,
              messages,
              state: {
                ...current.state,
                nextCitationNumber: Math.max(
                  typeof current.state?.['nextCitationNumber'] === 'number'
                    ? current.state['nextCitationNumber']
                    : 1,
                  evidence.nextNumber,
                ),
              },
            }
            const pending = terminalFailure ? null : pendingRun(responseMessage, runId, now())
            if (pending === null) {
              if (resumeRunId !== undefined) await clearPendingRun(sessionStore, next, resumeRunId)
              else await sessionStore.set(next)
            } else {
              await savePendingRun(sessionStore, next, {
                ...pending,
                expiresAt:
                  now() + Math.max(CHECKPOINT_TTL_MS, config.agent.stopWhen.seconds * 10_000),
                tokensUsed: (progress.tokensUsed ?? 0) + totalTokens,
                activeMs: (progress.activeMs ?? 0) + Math.max(0, now() - startedAt),
                stepsTaken: (progress.stepsTaken ?? 0) + completedSteps,
              })
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
      ctx = { ...ctx, locale: resolveLocale(config.ui, { override: request.locale ?? ctx.locale }) }
      try {
        return await withSpan(tracer, 'sitebot.handleChat', async (span) => {
          span.setAttribute('sitebot.mode', config.mode)
          span.setAttribute('sitebot.session_id', ctx.sessionId)

          const resolvedSystem = await resolveSystem(config, ctx)

          // `onMessage` rewrites the visitor's message before composition and
          // history see it (docs/04 §9).
          if (hooks.onMessage !== undefined && request.trigger !== 'resume') {
            const index = request.messages.findLastIndex((message) => message.role === 'user')
            const original = request.messages[index]
            const rewritten = original && (await runHook(hooks, 'onMessage', ctx, original, ctx))
            if (rewritten && typeof rewritten === 'object') {
              request = { ...request, messages: request.messages.with(index, rewritten) }
            }
          }

          // Restore generic provenance only from trusted server history.
          const sourceSession =
            config.storage.type === 'none' ? null : await sessionStore.get(request.sessionId)
          const evidence = new SourceEvidence(
            sourceSession?.messages,
            sourceSession?.state?.['nextCitationNumber'],
          )
          const composed = composePrompt({
            config,
            system: resolvedSystem,
            ctx: { pageContext: ctx.pageContext, identity: ctx.identity, locale: ctx.locale },
          })
          if (composed.missingVariables.length > 0) {
            ctx.logger.warn('prompt has unresolved {{variables}}', {
              variables: composed.missingVariables,
            })
          }
          const system = composed.text

          let history: UIMessage[]
          let session = await sessionStore.get(request.sessionId)
          let resumeRunId: string | undefined
          let stepsTaken = 0
          let tokensUsed = 0
          let activeMs = 0
          let abandonsRun = false
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
            // docs/04 §4: `maxSteps` bounds the run, not the request. Each
            // client-tool round trip is a new request, and without this every
            // one of them started a fresh step budget.
            stepsTaken = loaded.pending.stepsTaken ?? stepCount(loaded.pending.responseMessage)
            tokensUsed = loaded.pending.tokensUsed ?? 0
            activeMs = loaded.pending.activeMs ?? 0
            const resumedPolicy = resolvePolicy(config, { stepsTaken, tokensUsed, activeMs, now })
            if (resumedPolicy.stepsExhausted || resumedPolicy.budgetExhausted) {
              await clearPendingRun(sessionStore, loaded.session, request.resume.runId)
              return limitResponse(ctx, loaded.pending, resumedPolicy.budgetExhausted)
            }
            const resumed = await applyResume(loaded.session, loaded.pending, request.resume, ctx)
            session = resumed.session
            await sessionStore.set(session)
            if (resumed.handoffs.length > 0) {
              return clientHandoffResponse(
                ctx.requestId,
                request.resume.runId,
                loaded.pending.responseMessage.id,
                resumed.handoffs,
              )
            }
            history = session.messages
            resumeRunId = request.resume.runId
          } else {
            const settled = settleDanglingToolCalls(await buildHistory(request))
            history = settled.messages
            abandonsRun = settled.settled > 0 || hasPendingRun(session)
          }
          const budgetTokens = contextBudget({
            modelId: `${config.backend.provider}:${config.backend.model}`,
            systemTokens: estimateTokens(system),
            maxOutputTokens: config.backend.maxOutputTokens,
          })
          let truncated = truncateHistory(history, { budgetTokens })
          // docs/04 §6 step 5: more than a few dropped turns get a summary, so
          // a long conversation keeps its thread instead of losing it.
          if (truncated.summaryNeeded) {
            const summary = await summarizeDropped(
              history.slice(0, truncated.dropped),
              session,
              ctx,
            )
            if (summary !== undefined) {
              truncated = truncateHistory(history, { budgetTokens, summary })
              if (session !== null) session = await sessionStore.get(request.sessionId)
            }
          }
          const estimatedTokens =
            estimateTokens(system) +
            Math.ceil(JSON.stringify(truncated.messages).length / 4) +
            config.backend.maxOutputTokens
          const budgetDecision = await ctx.budget.check(
            estimatedTokens,
            `${config.backend.provider}:${config.backend.model}`,
          )
          if (budgetDecision === 'block') {
            if (config.security.budget.onExceeded === 'message') {
              return budgetMessageResponse(ctx.requestId, ctx.locale)
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

          evidence.retain(truncated.messages)
          const { stream, modelId } = await startStream(
            await evidence.modelMessages(truncated.messages),
            truncated.messages,
            system,
            evidence,
            ctx,
            session,
            resumeRunId,
            selectedChain,
            composed,
            { stepsTaken, tokensUsed, activeMs },
          )
          span.setAttribute('sitebot.model', modelId)

          if (abandonsRun && config.storage.type !== 'none') {
            const current = await sessionStore.get(request.sessionId)
            if (current !== null) {
              await abandonPendingRun(
                sessionStore,
                current,
                settleDanglingToolCalls(current.messages).messages,
              )
            }
          }

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
        reportError(hooks, error, ctx)
        dispatcher.emit(
          'error',
          { code: mapError(error, errorOptions).code },
          { requestId: ctx.requestId, sessionId: ctx.sessionId },
        )
        return errorResponse(error, {
          ...errorOptions,
          locale: ctx.locale,
          localization: config.ui,
        })
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
      const entry = config.tools.find((candidate) => candidate.name === name)
      return {
        ...publicConfig,
        pending: {
          runId: pending.runId,
          approval: {
            approvalId: part.approval.id,
            toolName: name,
            toolCallId: part.toolCallId,
            input: part.input,
            risk: entry ? entry.approvalRisk : 'medium',
            ...(entry && entry.approvalSummary ? { description: entry.approvalSummary } : {}),
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
            baseDir: config.$meta.baseDir,
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
      // a non-essential MCP service is unavailable.
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
      const failures: unknown[] = []
      // One unreachable store must not leak the other owned resources during
      // shutdown. Preserve the drain/close order and report every failure.
      for (const cleanup of [
        () => dispatcher.drain(),
        () => sessionStore.dispose?.(),
        () => rateLimitStore.dispose?.(),
        () => mcpPool.dispose(),
      ]) {
        try {
          await cleanup()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Engine resource cleanup failed.')
    },
  }

  function budgetMessageResponse(requestId: string, locale: string): Response {
    const id = 'budget-message'
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: 'text-start', id })
        writer.write({
          type: 'text-delta',
          id,
          delta: createTranslator(config.ui, locale)('budgetExceeded'),
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
    ctx: RequestContext,
  ): Promise<{ session: typeof session; handoffs: ClientToolHandoff[] }> {
    let responseMessage = structuredClone(pending.responseMessage)
    let nextSession = session
    const handoffs: ClientToolHandoff[] = []

    for (const approval of resume.approvals ?? []) {
      const part = findToolPart(
        responseMessage,
        (candidate) =>
          candidate.state === 'approval-requested' &&
          candidate.approval?.id === approval.approvalId,
      )
      if (part === undefined) throw new CheckpointError('Approval replay was rejected.', 403)
      const approved = approval.decision === 'approve'
      await authorizeTool(toolName(part), part.input, ctx, true, false)
      // docs/03 §5 rule 3: a deny reaches the model as a tool result
      // (`execution-denied`) that says the visitor declined, so it can answer
      // gracefully instead of retrying or failing.
      // The reason is the whole tool result some providers show the model, so
      // it says in words that nothing happened: a bare code was read as
      // success often enough for the model to claim it had acted.
      part.approval = { ...part.approval, approved, ...(approved ? {} : { reason: USER_DENIED }) }
      // An approved client tool has no server executor for the model run to
      // call: it goes back to the page, which answers with `clientToolResults`.
      if (approved && isClientTool(toolName(part)) && part.toolCallId !== undefined) {
        const input = await authorizeTool(toolName(part), part.input, ctx, true, true)
        part.state = 'input-available'
        handoffs.push({ toolCallId: part.toolCallId, toolName: toolName(part), input })
      } else part.state = 'approval-responded'
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
      await authorizeTool(toolName(part), part.input, ctx, true, false)
      part.state = 'output-available'
      part.output = await checkClientToolResult(toolName(part), result.output, ctx)
    }

    if ((resume.approvals?.length ?? 0) + (resume.clientToolResults?.length ?? 0) === 0) {
      throw new CheckpointError('A resume result is required.', 403)
    }

    responseMessage = { ...responseMessage, parts: responseMessage.parts }
    return {
      session: {
        ...nextSession,
        messages: replaceOrAppend(nextSession.messages, responseMessage),
        state: { ...nextSession.state, pendingRun: { ...pending, responseMessage } },
      },
      handoffs,
    }
  }

  /**
   * Answers a resume whose approvals released client tools: the page runs
   * them and resumes again with results, so no model call happens yet. The
   * pending run stays checkpointed for that second resume.
   */
  function clientHandoffResponse(
    requestId: string,
    runId: string,
    messageId: string,
    handoffs: ClientToolHandoff[],
  ): Response {
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: 'start', messageId })
        for (const call of handoffs) {
          writer.write({
            type: 'data-client-tool-call',
            transient: true,
            data: { runId, ...call },
          } as UIMessageChunk)
        }
        writer.write({ type: 'finish', finishReason: 'tool-calls' } as UIMessageChunk)
      },
    })
    return createUIMessageStreamResponse({
      stream,
      headers: { 'x-sitebot-request-id': requestId },
    })
  }

  /**
   * Ends a resumed run whose step, token, or active-time budget is spent,
   * without calling the model. The final summary belongs inside the ceiling.
   * Persist the same explicit outcome the client sees, settling unfinished calls.
   */
  function limitResponse(
    ctx: RequestContext,
    pending: PendingRun,
    budgetExhausted = false,
  ): Response {
    const previous = settleDanglingToolCalls([pending.responseMessage]).messages[0]!
    const stream = createUIMessageStream({
      originalMessages: [previous],
      execute: ({ writer }) => {
        writer.write({ type: 'start', messageId: previous.id })
        const failed =
          budgetExhausted ||
          config.agent.onMaxSteps !== 'silent' ||
          answerCharacters(previous) === 0
        if (failed) {
          const mapped = mapError(
            new EngineError(budgetExhausted ? 'budget_exceeded' : 'max_steps_exceeded'),
            { ...errorOptions, locale: ctx.locale, localization: config.ui },
          )
          writer.write({
            type: 'data-error',
            data: { ...mapped, retryable: false },
          } as UIMessageChunk)
        }
        writer.write({ type: 'finish', finishReason: failed ? 'error' : 'stop' } as UIMessageChunk)
      },
      onFinish: async ({ responseMessage }) => {
        const current = await sessionStore.get(ctx.sessionId)
        if (current)
          await sessionStore.set({
            ...current,
            messages: replaceOrAppend(current.messages, responseMessage),
          })
      },
    })
    return createUIMessageStreamResponse({
      stream,
      headers: { 'x-sitebot-request-id': ctx.requestId },
    })
  }

  /**
   * A summary of the turns truncation dropped (docs/04 §6 step 5), cached in
   * the session and refreshed once {@link SUMMARY_REFRESH} more messages have
   * been dropped since. Made with `security.budget.degradeTo` when one is
   * configured — the config's own "cheap model" — else the primary, and
   * charged to the budget like any call. Any failure means no summary, never
   * a failed chat.
   */
  async function summarizeDropped(
    dropped: UIMessage[],
    session: Awaited<ReturnType<SessionStore['get']>>,
    ctx: RequestContext,
  ): Promise<string | undefined> {
    const cached = session?.state?.['historySummary'] as
      { droppedCount: number; text: string } | undefined
    if (cached !== undefined && dropped.length - cached.droppedCount < SUMMARY_REFRESH)
      return cached.text
    try {
      const entry = config.security.budget.degradeTo ?? chain[0]!
      const resolved = await resolveModel(entry, {
        ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
        baseDir: config.$meta.baseDir,
      })
      const transcript = dropped
        .map((message) => {
          const text = message.parts
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join(' ')
          return text === '' ? '' : `${message.role}: ${text}`
        })
        .filter(Boolean)
        .join('\n')
      const result = await generateText({
        model: withModelTimeout(resolved.model, entry.timeoutMs),
        system:
          'Summarise this earlier part of a website chat in at most five short sentences: what the visitor wanted, what they were told, and anything still open. Plain text, no preamble.',
        prompt: transcript,
        maxOutputTokens: 300,
        maxRetries: entry.maxRetries,
        abortSignal: ctx.signal,
      })
      await ctx.budget.record(
        {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          totalTokens: result.usage.totalTokens ?? 0,
        },
        resolved.id,
      )
      const text = `Summary of the earlier conversation, which is no longer shown in full:\n${result.text.trim()}`
      if (session !== null && config.storage.type !== 'none') {
        await sessionStore.set({
          ...session,
          state: { ...session.state, historySummary: { droppedCount: dropped.length, text } },
        })
      }
      return text
    } catch (error) {
      ctx.logger.warn('history summary failed; continuing without it', { error })
      return undefined
    }
  }

  function isClientTool(name: string): boolean {
    return config.tools.some((entry) => entry.name === name && entry.executor?.type === 'client')
  }

  /**
   * docs/05 §5 rule 5, enforced where it counts. A client tool's result comes
   * from the browser, and the widget's own 16 KB cap binds only an honest
   * widget: the server caps it again and checks it against the tool's
   * `outputSchema`, so a tampered page can neither flood the context nor hand
   * the model a result shaped unlike anything the tool returns.
   */
  async function authorizeTool(
    name: string,
    input: unknown,
    ctx: RequestContext,
    approved: boolean,
    count: boolean,
  ): Promise<unknown> {
    const entry = config.tools.find((tool) => tool.name === name)
    const policy = resolvePolicy(config)
    if (
      !entry ||
      !isToolEnabled(entry.enabled) ||
      !policy.toolFilter(entry) ||
      policy.toolChoice === 'none' ||
      (entry.scope === 'authenticated' && !ctx.identity)
    )
      throw new CheckpointError('Tool is no longer authorized.', 403)
    return withDeadline(entry.timeoutMs, ctx.signal, async (signal) => {
      const parsed = await compileToolSchema(entry.parameters, true).parse(input)
      checkDeadline(signal)
      if (!parsed.ok) throw new CheckpointError('Invalid tool input.', 403)
      if (
        !approved &&
        config.agent.approvalPolicy !== 'never' &&
        (entry.requiresApproval || config.agent.approvalRequired.includes(name))
      ) {
        const session = await sessionStore.get(ctx.sessionId)
        if (!(
          config.agent.approvalPolicy === 'once-per-session' &&
          (await hasApprovalGrant(session, name, input))
        ))
          throw new CheckpointError('Tool approval is required.', 403)
      }
      if (
        count &&
        entry.maxCallsPerSession !== undefined &&
        !(await sessionStore.claimToolCall?.(ctx.sessionId, name, entry.maxCallsPerSession))
      )
        throw new CheckpointError('Tool call limit reached.', 403)
      checkDeadline(signal)
      return parsed.value
    })
  }

  async function checkClientToolResult(
    name: string,
    output: unknown,
    ctx: RequestContext,
  ): Promise<unknown> {
    try {
      if ((JSON.stringify(output) ?? '').length > CLIENT_RESULT_MAX_CHARS)
        return { error: 'result_too_large' }
      const entry = config.tools.find((tool) => tool.name === name)
      if (!entry) return { error: 'invalid_output' }
      const checked = await withDeadline(entry.timeoutMs, ctx.signal, async () =>
        compileToolSchema(entry.outputSchema).parse(output),
      )
      return checked.ok ? snapshotToolValue(checked.value) : { error: 'invalid_output' }
    } catch {
      return { error: 'invalid_output' }
    }
  }
}

/** docs/04 §6 step 5: refresh a cached summary every this many newly dropped messages. */
const SUMMARY_REFRESH = 10

/** docs/03 §5 rule 3: the `execution-denied` reason. */
const USER_DENIED =
  'user_denied: the visitor declined this action, so it was NOT performed. Do not say or imply that it was done.'

/** Same bound as the widget's (docs/05 §5 rule 5). */
const CLIENT_RESULT_MAX_CHARS = 16_384

// ── citations ───────────────────────────────────────────────────────────────

type ClientToolHandoff = { toolCallId: string; toolName: string; input: unknown }

/** Only a continued assistant message contributes prior visitor-facing text. */
function answerCharacters(message: UIMessage | undefined): number {
  return message?.role === 'assistant'
    ? message.parts.reduce(
        (count, part) => count + (part.type === 'text' ? part.text.trim().length : 0),
        0,
      )
    : 0
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

/**
 * Model steps a run has taken so far. A resumed run continues the same
 * assistant message, and every step opens with a `step-start` part.
 */
function stepCount(message: UIMessage): number {
  return message.parts.filter((part) => part.type === 'step-start').length
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
    authorizeClient: (name: string, input: unknown) => Promise<unknown>
    config: ResolvedConfig
    debug: boolean
    locale: string
    usage: () => { inputTokens: number; outputTokens: number; costUsd: number } | undefined
  },
): ReadableStream<UIMessageChunk> {
  const calls = new Map<string, { toolName: string; input: unknown }>()
  const approvals = new Set<string>()
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      async transform(chunk, controller) {
        if (chunk.type === 'start') {
          controller.enqueue(chunk)
          const ui = options.config.ui
          const suggestions = [
            ...localeTables(ui.translations, ui.locale === 'auto' ? 'en' : ui.locale),
            ...localeTables(ui.translations, options.locale),
          ].reduce((items, copy) => copy.messages?.suggestions ?? items, ui.messages.suggestions)
          if (suggestions.length > 0) {
            controller.enqueue({
              type: 'data-suggestions',
              data: { items: suggestions, locale: options.locale },
            } as UIMessageChunk)
          }
          return
        }
        if (chunk.type === 'error') {
          const mapped = mapError(new EngineError('provider_error'), {
            locale: options.locale,
            localization: options.config.ui,
          })
          controller.enqueue({
            type: 'data-error',
            data: { ...mapped, message: chunk.errorText, retryable: true },
          } as UIMessageChunk)
          return
        }
        if (chunk.type === 'tool-input-available') {
          calls.set(chunk.toolCallId, { toolName: chunk.toolName, input: chunk.input })
        }
        if (chunk.type === 'tool-approval-request') {
          approvals.add(chunk.toolCallId)
          const call = calls.get(chunk.toolCallId)
          const entry = options.config.tools.find((candidate) => candidate.name === call?.toolName)
          controller.enqueue({
            type: 'data-approval-request',
            data: {
              approvalId: chunk.approvalId,
              runId: options.runId,
              toolCallId: chunk.toolCallId,
              toolName: call?.toolName,
              input: call?.input,
              risk: entry ? entry.approvalRisk : 'medium',
              description: entry ? entry.approvalSummary : undefined,
            },
          } as UIMessageChunk)
        }
        if (chunk.type === 'finish') {
          for (const [toolCallId, call] of calls) {
            if (!options.clientTools.has(call.toolName) || approvals.has(toolCallId)) continue
            try {
              const input = await options.authorizeClient(call.toolName, call.input)
              controller.enqueue({
                type: 'data-client-tool-call',
                transient: true,
                data: { runId: options.runId, toolCallId, ...call, input },
              } as UIMessageChunk)
            } catch {
              controller.enqueue({
                type: 'tool-output-error',
                toolCallId,
                errorText: 'Tool unavailable.',
              } as UIMessageChunk)
            }
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
