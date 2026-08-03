import type { ResolvedConfig } from '@sitebot/config'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import {
  checkContentLength,
  checkPublicKey,
  createBudgetTracker,
  createEngine,
  createEventDispatcher,
  createJwtVerifier,
  createLogger,
  EngineError,
  errorResponse,
  mapError,
  MemoryRateLimitStore,
  noopDispatcher,
  parseChatRequest,
  redactPiiMessages,
  runGuards,
  type Engine,
  type EngineDeps,
  type EventDispatcher,
  type Logger,
  type RateLimitStore,
  type RequestContext,
  type TokenVerifier,
} from '@sitebot/core'
import { corsHeaders, preflightResponse, withHeaders } from './http/cors.js'
import {
  extractToken,
  newRequestId,
  parseJsonBody,
  readBodyWithLimit,
  resolveClientIp,
  resolveLocale,
  selfOriginOf,
} from './http/context.js'

/**
 * The fetch handler — docs/03-protocol.md §1.
 *
 * Every adapter in this package wraps this one function. That is the whole
 * design of layer 3: there is exactly one implementation of the protocol, and
 * "supporting Fastify" means translating a `FastifyRequest` into a `Request`,
 * not reimplementing four endpoints and a CORS policy a fifth time.
 */

export const DEFAULT_BASE_PATH = '/api/chat'

/** The four endpoints, relative to `basePath`. docs/03-protocol.md §1. */
export const ROUTES = {
  chat: '',
  config: '/config',
  feedback: '/feedback',
  health: '/health',
} as const

export type RouteName = keyof typeof ROUTES

export interface Feedback {
  sessionId: string
  messageId: string
  rating: 'up' | 'down'
  reason?: string
  comment?: string
}

export interface SiteBotHandlerOptions {
  /** Where the four endpoints are mounted. Default `/api/chat`. */
  basePath?: string
  /** Reported in `/config` and `/health`. */
  version?: string
  /** Bring your own engine — `sitebot dev` reuses one across config reloads. */
  engine?: Engine
  /** Passed through to `createEngine`. */
  deps?: EngineDeps
  /** Shared with the engine so one limiter governs the whole deployment. */
  rateLimitStore?: RateLimitStore
  /** JWT verification. Phase 8 ships the implementation. */
  verifier?: TokenVerifier
  logger?: Logger
}

/**
 * Per-request facts a Web `Request` cannot carry.
 *
 * Only the socket peer address, for now. It is a second argument rather than a
 * header because a header would be indistinguishable from one the client set —
 * which is exactly the confusion `trustProxy` exists to prevent.
 */
export interface RequestInfo {
  clientIp?: string | null
}

export interface SiteBotHandler {
  (request: Request, info?: RequestInfo): Promise<Response>
  engine: Engine
  dispose(): Promise<void>
}

const MAX_COMMENT_CHARS = 1000

export function createSiteBotHandler(
  config: ResolvedConfig,
  options: SiteBotHandlerOptions = {},
): SiteBotHandler {
  const basePath = normaliseBasePath(options.basePath ?? DEFAULT_BASE_PATH)
  const logger =
    options.logger ??
    createLogger({
      level: config.telemetry.logLevel,
      redactPrompts: config.telemetry.redactPromptsInLogs,
    })

  // One rate-limit store for the whole deployment: the guards here and any
  // future budget accounting in the engine must agree on the counters, and two
  // stores would silently double every limit.
  const rateLimitStore =
    options.rateLimitStore ??
    (config.security.rateLimit.store === 'memory'
      ? new MemoryRateLimitStore()
      : (() => {
          throw new EngineError('not_ready', {
            detail: 'rateLimit.store is redis but no Redis rate-limit store was supplied',
          })
        })())
  const verifier =
    options.verifier ??
    (config.security.auth.jwt === undefined
      ? undefined
      : createJwtVerifier({
          ...(options.deps?.fetchImpl === undefined ? {} : { fetchImpl: options.deps.fetchImpl }),
        }))

  const dispatcher: EventDispatcher =
    config.telemetry.enabled && config.telemetry.events.webhook !== undefined
      ? createEventDispatcher({ telemetry: config.telemetry, logger })
      : noopDispatcher

  // `engineDeps` is assembled here so the knowledge block below can attach
  // itself post-hoc when it resolves. Callers who passed `options.engine`
  // supplied their own deps and manage knowledge themselves.
  const engineDeps: EngineDeps = {
    logger,
    rateLimitStore,
    dispatcher,
    ...options.deps,
  }
  const engine =
    options.engine ??
    createEngine(
      config,
      engineDeps,
      { ...(options.version === undefined ? {} : { version: options.version }) },
    )

  // Phase 6: build the knowledge store when sources are configured (the
  // engine, not the CLI, owns query-time retrieval). Boot is lazy — the
  // promise resolves on the first request, so a cold start pays nothing when
  // knowledge is not configured at all. A store that fails to open degrades
  // knowledge; chat keeps working, per docs/06 §3.7.
  let knowledgeReady: Promise<void> | undefined
  function ensureKnowledge(): Promise<void> {
    knowledgeReady ??= (async () => {
      if (options.engine !== undefined) return // external engine, external deps
      if (config.knowledge.sources.length === 0 || config.knowledge.embedding === undefined) return
      try {
        const { createNodeVectorStore } = await import('@sitebot/core/node')
        const { createQueryEmbedder } = await import('@sitebot/ingest')
        const store = await createNodeVectorStore(config.knowledge.store, {
          model: config.knowledge.embedding.model,
          baseDir: config.$meta.baseDir ?? null,
        })
        const embedder = await createQueryEmbedder(config.knowledge.embedding)
        engineDeps.knowledge = { store, embedder }
      } catch (error) {
        logger.warn('knowledge store unreachable; chat continues without RAG', { error })
      }
    })()
    return knowledgeReady
  }

  const debug = config.telemetry.logLevel === 'debug'
  const production =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.NODE_ENV === 'production'
  const errorOptions = { debug, production }

  // ── endpoints ─────────────────────────────────────────────────────────────

  async function handleChat(
    request: Request,
    cors: Record<string, string>,
    info: RequestInfo,
  ): Promise<Response> {
    const { security } = config

    // Knowledge is boot-lazy; the first chat request awaits it so retrieval
    // is present from the first answer, not the second.
    await ensureKnowledge()

    // Cheap first: the declared size, before a byte of the body is read.
    checkContentLength(request.headers.get('content-length'), security.maxRequestBytes)
    const raw = await readBodyWithLimit(request, security.maxRequestBytes)
    const chatRequest = parseChatRequest(parseJsonBody(raw))
    const token = extractToken(request, chatRequest.auth)
    const budget = createBudgetTracker({
      budget: security.budget,
      sessionId: chatRequest.sessionId,
      store: rateLimitStore,
      pricing: config.backend.pricing,
      logger,
    })

    const ip = resolveClientIp(request.headers, security.trustProxy, info.clientIp)

    const guarded = await runGuards(
      {
        config,
        origin: request.headers.get('origin'),
        key: request.headers.get('x-sitebot-key'),
        ip,
        sessionId: chatRequest.sessionId,
        messages: chatRequest.messages,
        token,
        selfOrigin: selfOriginOf(request),
      },
      {
        rateLimitStore,
        budget,
        logger,
        ...(verifier === undefined ? {} : { verifier }),
      },
    )

    if (guarded.budget !== 'ok') {
      dispatcher.emit(
        'budget_exceeded',
        { action: security.budget.onExceeded, decision: guarded.budget },
        { sessionId: chatRequest.sessionId },
      )
      logger.error('budget exceeded', {
        sessionId: chatRequest.sessionId,
        action: security.budget.onExceeded,
      })
    }
    if (guarded.budget === 'block') {
      if (security.budget.onExceeded === 'error') throw new EngineError('budget_exceeded')
      return budgetMessageResponse(cors)
    }

    await engine.bindSessionIdentity?.(
      chatRequest.sessionId,
      guarded.identity === null ? null : token,
      await requestFingerprint(request, ip),
    )

    const safeRequest = {
      ...chatRequest,
      messages:
        security.redactPii && security.piiPatterns.length > 0
          ? redactPiiMessages(chatRequest.messages, security.piiPatterns)
          : chatRequest.messages,
    }

    const requestId = newRequestId()
    const ctx: RequestContext = {
      requestId,
      sessionId: chatRequest.sessionId,
      identity: guarded.identity,
      pageContext: config.prompt.includePageContext ? (chatRequest.pageContext ?? null) : null,
      origin: request.headers.get('origin') ?? selfOriginOf(request) ?? '',
      locale: resolveLocale(request.headers, config.ui.locale),
      ip,
      signal: request.signal,
      logger: logger.child({ requestId, sessionId: chatRequest.sessionId }),
      budget,
    }

    const response = await engine.handleChat(safeRequest, ctx)
    return withHeaders(response, {
      ...cors,
      'x-sitebot-request-id': requestId,
      // docs/03 §11: defeat nginx and Cloudflare buffering of the SSE body.
      'x-accel-buffering': 'no',
    })
  }

  function budgetMessageResponse(cors: Record<string, string>): Response {
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
    return withHeaders(createUIMessageStreamResponse({ stream }), cors)
  }

  async function requestFingerprint(request: Request, ip: string | null): Promise<string> {
    const origin = request.headers.get('origin') ?? selfOriginOf(request) ?? ''
    const userAgent = request.headers.get('user-agent') ?? ''
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(userAgent),
    )
    const userAgentHash = Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    return `${coarseIp(ip)}|${origin}|${userAgentHash}`
  }

  function coarseIp(ip: string | null): string {
    if (ip === null) return 'unknown'
    if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':')
    return ip.split('.').slice(0, 3).join('.')
  }

  /**
   * docs/03 §6. Cacheable by `key`, except when a `sessionId` is supplied — the
   * response then carries `pending` (Phase 5's approval probe), which is
   * per-session and must never land in a shared cache.
   */
  function handleConfig(request: Request, cors: Record<string, string>): Response {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')

    // The key may arrive as a query parameter here: `GET /config` is fetched by
    // the widget before it has a session, sometimes as a plain navigation.
    checkKey(url.searchParams.get('key') ?? request.headers.get('x-sitebot-key'))

    return Response.json(engine.getPublicConfig(), {
      headers: {
        ...cors,
        'cache-control':
          sessionId === null
            ? 'public, max-age=60, stale-while-revalidate=600'
            : 'private, no-store',
      },
    })
  }

  /** docs/03 §7. */
  async function handleFeedback(request: Request, cors: Record<string, string>): Promise<Response> {
    checkContentLength(request.headers.get('content-length'), config.security.maxRequestBytes)
    const body = parseJsonBody(await readBodyWithLimit(request, config.security.maxRequestBytes))
    const feedback = parseFeedback(body)

    checkKey(request.headers.get('x-sitebot-key'))

    dispatcher.emit('feedback', { ...feedback }, { sessionId: feedback.sessionId })

    const hook = config.hooks?.onFeedback as
      ((feedback: Feedback) => unknown | Promise<unknown>) | undefined
    if (hook !== undefined) {
      try {
        await hook(feedback)
      } catch (error) {
        // A throwing hook logs and continues (docs/04 §9). Losing a thumbs-up
        // is not worth failing the request the user just made.
        logger.error('onFeedback hook threw', { error })
      }
    }

    return new Response(null, { status: 204, headers: cors })
  }

  /**
   * docs/03 §8. `degraded` is a 200 — a non-essential subsystem being down is
   * information for a dashboard, not a reason for a load balancer to pull the
   * instance out of rotation.
   */
  async function handleHealth(cors: Record<string, string>): Promise<Response> {
    await ensureKnowledge()
    const report = await engine.health()
    return Response.json(report, {
      status: report.status === 'error' ? 503 : 200,
      headers: { ...cors, 'cache-control': 'no-store' },
    })
  }

  /**
   * `POST /` runs this inside `runGuards`; the other two endpoints have no
   * guard pipeline of their own, so they call the same check directly rather
   * than growing a second, subtly different one.
   */
  function checkKey(presented: string | null): void {
    checkPublicKey(presented, config.security.publicKey)
  }

  // ── the router ────────────────────────────────────────────────────────────

  const handler = async function siteBotHandler(
    request: Request,
    info: RequestInfo = {},
  ): Promise<Response> {
    const route = resolveRoute(new URL(request.url).pathname, basePath)

    if (route === null) {
      return new Response(JSON.stringify({ code: 'invalid_request', message: 'Not found.' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    // Preflight is answered before anything else, and without touching the
    // body: a browser sends it with no credentials and expects an answer fast.
    if (request.method === 'OPTIONS') {
      return preflightResponse({
        config,
        origin: request.headers.get('origin'),
        selfOrigin: selfOriginOf(request),
      })
    }

    let cors: Record<string, string>
    try {
      // The origin is checked on the real request too, not just the preflight
      // (docs/08 §7) — a simple POST never triggers one.
      cors = corsHeaders({
        config,
        origin: request.headers.get('origin'),
        selfOrigin: selfOriginOf(request),
      })
    } catch (error) {
      return errorResponse(error, errorOptions)
    }

    try {
      switch (route) {
        case 'chat':
          if (request.method !== 'POST') return methodNotAllowed('POST', cors)
          return await handleChat(request, cors, info)
        case 'config':
          if (request.method !== 'GET') return methodNotAllowed('GET', cors)
          return handleConfig(request, cors)
        case 'feedback':
          if (request.method !== 'POST') return methodNotAllowed('POST', cors)
          return await handleFeedback(request, cors)
        case 'health':
          if (request.method !== 'GET') return methodNotAllowed('GET', cors)
          return await handleHealth(cors)
      }
    } catch (error) {
      logger.error('request failed', { error, route })
      dispatcher.emit('error', { code: mapError(error, errorOptions).code, route })
      return withHeaders(errorResponse(error, errorOptions), cors)
    }
  } as SiteBotHandler

  handler.engine = engine
  handler.dispose = async () => {
    await engine.dispose()
    await dispatcher.drain()
  }

  return handler
}

// ── routing ─────────────────────────────────────────────────────────────────

function normaliseBasePath(basePath: string): string {
  const withLeading = basePath.startsWith('/') ? basePath : `/${basePath}`
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading
}

const SUFFIXES: Record<string, RouteName> = {
  '/config': 'config',
  '/feedback': 'feedback',
  '/health': 'health',
}

/**
 * Map a pathname onto one of the four routes.
 *
 * Two shapes have to work, because adapters disagree about what they hand us:
 * a full pathname (`/api/chat/config`, from Next.js and the fetch adapter) and
 * a mount-relative one (`/config`, from `app.use()` in Express). Rather than
 * make every adapter reconstruct the full path, the fallback matches the
 * recognised suffixes — which is also what makes the handler work unchanged
 * when a developer mounts it somewhere other than `basePath` says.
 */
export function resolveRoute(pathname: string, basePath: string): RouteName | null {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

  if (path === basePath) return 'chat'
  if (path.startsWith(`${basePath}/`)) {
    return SUFFIXES[path.slice(basePath.length)] ?? null
  }

  // Mount-relative.
  if (path === '' || path === '/') return 'chat'
  return SUFFIXES[path] ?? null
}

function methodNotAllowed(allowed: string, cors: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ code: 'invalid_request', message: 'That request could not be understood.' }),
    {
      status: 405,
      headers: { ...cors, 'content-type': 'application/json', allow: `${allowed}, OPTIONS` },
    },
  )
}

function parseFeedback(body: unknown): Feedback {
  if (typeof body !== 'object' || body === null) {
    throw new EngineError('invalid_request', { detail: 'feedback body is not an object' })
  }
  const raw = body as Record<string, unknown>

  if (typeof raw.sessionId !== 'string' || raw.sessionId === '') {
    throw new EngineError('invalid_request', { detail: 'feedback.sessionId is required' })
  }
  if (typeof raw.messageId !== 'string' || raw.messageId === '') {
    throw new EngineError('invalid_request', { detail: 'feedback.messageId is required' })
  }
  if (raw.rating !== 'up' && raw.rating !== 'down') {
    throw new EngineError('invalid_request', { detail: 'feedback.rating must be up or down' })
  }
  if (typeof raw.comment === 'string' && raw.comment.length > MAX_COMMENT_CHARS) {
    throw new EngineError('invalid_request', {
      detail: `feedback.comment exceeds ${MAX_COMMENT_CHARS} characters`,
    })
  }

  return {
    sessionId: raw.sessionId,
    messageId: raw.messageId,
    rating: raw.rating,
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    ...(typeof raw.comment === 'string' ? { comment: raw.comment } : {}),
  }
}
