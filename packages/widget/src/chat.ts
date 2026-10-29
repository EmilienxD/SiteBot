import { en, type MessageKey } from '@sitebot/config/i18n'
import { createStrings, hostLocale } from './strings.js'
import { signal } from '@preact/signals'
import type { PublicConfig } from '@sitebot/config'
import { extractPageContext } from './context.js'
import {
  registerClientTool,
  runClientTool,
  unregisterClientTool,
  type ClientToolHandler,
} from './client-tools.js'
import {
  createSessionId,
  readMessages,
  readValue,
  removeValue,
  storageKey,
  writeMessages,
  writeValue,
} from './storage.js'
import { applyChunk, isTool, readEvents, startMessage, StreamError } from './ui-stream.js'
import type {
  HandoffData,
  InlineErrorData,
  PageContext,
  UIMessage,
  UIPart,
  UsageData,
  WidgetController,
  WidgetError,
  WidgetState,
} from './types.js'

type Status = 'ready' | 'submitted' | 'streaming' | 'error'
type Trigger = 'submit-message' | 'regenerate'

/**
 * The chat controller — the client half of docs/03-protocol.md, bound to
 * signals, with the widget state machine of docs/07-widget.md §7.
 *
 * `state` is derived rather than stored: the request status is the base, and
 * the two states the transport cannot see — a client tool executing in the
 * page, an approval card waiting on the user — are read off the messages and
 * the running-tool count when they apply.
 */
export function createController(
  options: WidgetController['options'],
  config: PublicConfig,
  notify: () => void,
): WidgetController {
  const prefix = options.publicKey || 'anonymous'
  const sessionKey = storageKey(prefix, 'sessionId')
  const historyKey = storageKey(prefix, 'history')
  const scope = config.ui.behaviour.sessionScope === 'browser' ? 'local' : 'session'
  let sessionId = readValue(sessionKey, scope) ?? createSessionId()
  writeValue(sessionKey, sessionId, scope)
  let identity: string | null = null
  let customContext: Record<string, unknown> = {}
  let pageContext: PageContext | null = null
  let pageHash: string | undefined
  let suggestionsLocale: string | undefined
  let statusKey: MessageKey | undefined
  let runtimeSuggestions: PublicConfig['ui']['messages']['suggestions'] | undefined
  const t = () => createStrings(config.ui, hostLocale(config.ui, options.locale))
  const listeners = new Set<() => void>()
  const status = signal<Status>('ready')
  const messages = signal<UIMessage[]>(
    config.ui.behaviour.persistHistory ? readMessages(historyKey, scope) : [],
  )
  const error = signal<WidgetError | undefined>(undefined)
  const retryAfter = signal<number | undefined>(undefined)
  const clientToolsRunning = signal(0)
  const statusText = signal<string | undefined>(undefined)
  const handoff = signal<HandoffData | undefined>(undefined)
  const inlineError = signal<InlineErrorData | undefined>(undefined)
  const usage = signal<UsageData | undefined>(undefined)
  let lastSend: { text: string; hidden?: boolean } | undefined
  let retryTimer: ReturnType<typeof setInterval> | undefined
  let abort: AbortController | undefined
  let inFlight: Promise<void> | undefined
  /** docs/07 §10: one automatic retry after a network drop, then manual. */
  let autoRetried = false
  const registeredTools = new Map<string, ClientToolHandler>()
  /** The run the last stream announced — needed to resume a client tool call. */
  let announcedRunId: string | undefined
  /** A same-tab navigation, held until the run settles (see `settleNavigation`). */
  let pendingNavigation: string | undefined

  const changed = () => {
    // Persisting on every token would serialise the whole history per delta;
    // the cache is a paint optimisation (docs/07 §9), so settle first.
    if (config.ui.behaviour.persistHistory && status.value !== 'streaming')
      writeMessages(historyKey, messages.value, scope)
    notify()
    listeners.forEach((listener) => listener())
  }
  const emit = (type: string, detail?: unknown) => {
    try {
      options.onEvent?.({ type: type as never, detail })
    } catch (cause) {
      console.warn('[SiteBot] an event handler threw', cause)
    }
  }
  const setMessages = (next: UIMessage[]) => {
    messages.value = next
    changed()
  }

  function onData(part: { type: string; data: unknown }): void {
    const payload = (part.data ?? {}) as Record<string, unknown>
    switch (part.type) {
      case 'data-suggestions': {
        const items = payload.items as PublicConfig['ui']['messages']['suggestions'] | undefined
        if (Array.isArray(items)) {
          runtimeSuggestions = items
          suggestionsLocale = typeof payload.locale === 'string' ? payload.locale : undefined
        }
        break
      }
      case 'data-navigate': {
        const path = typeof payload.path === 'string' ? payload.path : ''
        // docs/03 §4: only to server-declared `siteContext.routes`.
        if (config.capabilities.routes.includes(path)) {
          if (payload.newTab === true) window.open(path, '_blank', 'noopener,noreferrer')
          else pendingNavigation = path
        } else emit('error', { code: 'route_not_allowed', message: t()('navigationBlocked') })
        break
      }
      case 'data-handoff':
        handoff.value = payload as unknown as HandoffData
        openVendorHandoff(handoff.value)
        emit('handoff', { target: payload.target })
        break
      case 'data-status':
        statusKey =
          typeof payload.messageKey === 'string' && Object.hasOwn(en, payload.messageKey)
            ? (payload.messageKey as MessageKey)
            : undefined
        statusText.value = typeof payload.text === 'string' ? payload.text : undefined
        break
      case 'data-error':
        inlineError.value = payload as unknown as InlineErrorData
        break
      case 'data-usage':
        usage.value = payload as unknown as UsageData
        break
      case 'data-approval-request':
        emit('approval', { approvalId: payload.approvalId, toolName: payload.toolName })
        break
      case 'data-client-tool-call':
        if (typeof payload.runId === 'string' && payload.runId) announcedRunId = payload.runId
        clientToolsRunning.value += 1
        void runTool(payload)
        break
      default:
        return
    }
    changed()
  }

  /**
   * One POST, streamed into the message list. Resolves when the response ends
   * for any reason; failures land in `error`, never as a rejection.
   */
  async function request(trigger: Trigger): Promise<void> {
    const controller = new AbortController()
    abort = controller
    status.value = 'submitted'
    error.value = undefined
    changed()
    const history = messages.value
    const resume = resumePayload(history, announcedRunId, config.capabilities.clientTools)
    const body = {
      sessionId,
      locale: hostLocale(config.ui, options.locale),
      messages: history,
      trigger: resume ? 'resume' : trigger,
      ...(resume ? { resume } : {}),
      ...(pageContext
        ? {
            pageContext: {
              ...pageContext,
              locale: hostLocale(config.ui, options.locale),
              custom: customContext,
            },
          }
        : {}),
      ...(identity ? { auth: identity } : {}),
    }
    const streaming = startMessage(history.at(-1), `a_${createSessionId().replace(/-/g, '')}`)
    const continuing = history.at(-1)?.role === 'assistant'
    let wrote = false
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'accept-language': hostLocale(config.ui, options.locale),
          ...(options.publicKey ? { 'x-sitebot-key': options.publicKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw await responseError(response)
      // `pageHash` is the hash the *server* holds (docs/03 §10 cost control). It
      // moves only once a request carrying the extract has been accepted: a
      // refreshPageContext() or a failed send must not make the next request
      // send a bare hash the server has never seen.
      if (body.pageContext?.extract !== undefined) pageHash = body.pageContext.extractHash
      for await (const chunk of readEvents(response.body)) {
        if (!applyChunk(streaming, chunk, onData)) continue
        status.value = 'streaming'
        const current = messages.value
        const replace = continuing || wrote
        wrote = true
        setMessages(
          replace
            ? [...current.slice(0, -1), { ...streaming.message }]
            : [...current, { ...streaming.message }],
        )
      }
      if (controller.signal.aborted) throw abortError()
      status.value = 'ready'
      statusText.value = undefined
      autoRetried = false
      if (!hasPendingApproval(streaming.message) && clientToolsRunning.value === 0)
        announcedRunId = undefined
      changed()
      const text = textOf(streaming.message)
      if (text) emit('message', { role: 'assistant', text, messageId: streaming.message.id })
      settleNavigation()
    } catch (cause) {
      statusText.value = undefined
      if (controller.signal.aborted) {
        status.value = 'ready'
        changed()
        return
      }
      const normalized = normalizeError(cause, t()('errorMessage'))
      // docs/03 §5 rule 2: the server refused the resume, so the card it
      // answered and any chip still spinning on it are over.
      if (normalized.code === 'run_expired') settleDangling('expired')
      if (normalized.code === 'network' && !autoRetried) {
        // A dropped connection gets one silent retry. The server dedupes the
        // user turn by message id, so re-sending it cannot double it.
        autoRetried = true
        if (wrote && !continuing) setMessages(messages.value.slice(0, -1))
        return request('regenerate')
      }
      error.value = normalized
      setRetryAfter(normalized.retryAfter)
      status.value = 'error'
      changed()
      emit('error', { code: normalized.code, message: normalized.message })
    } finally {
      if (abort === controller) abort = undefined
    }
  }

  /**
   * Leave the page only once nothing is left to say: the answer has finished
   * streaming, no client tool is mid-flight, and no approval is waiting. The
   * transcript survives the load — server-side, and in the history cache.
   */
  function settleNavigation(): void {
    if (pendingNavigation === undefined || clientToolsRunning.value > 0) return
    const last = messages.value.at(-1)
    if (last && hasPendingApproval(last)) return
    const path = pendingNavigation
    pendingNavigation = undefined
    location.assign(path)
  }

  /** Remember the in-flight request so a new send can wait for it to unwind. */
  function track(pending: Promise<void>): Promise<void> {
    const current = pending.finally(() => {
      if (inFlight === current) inFlight = undefined
    })
    inFlight = current
    return current
  }

  async function settle(): Promise<void> {
    abort?.abort()
    await inFlight
  }

  async function runTool(value: Record<string, unknown>): Promise<void> {
    const tool = String(value.toolName)
    const toolCallId = String(value.toolCallId)
    emit('tool', { name: tool, phase: 'call', input: value.input })
    let output: unknown
    let failed = false
    try {
      output = await runClientTool(tool, value.input, {
        config,
        pageContext: async () => pageContext,
        registered: registeredTools,
        navigate: (path) => {
          pendingNavigation = path
        },
      })
      emit('tool', { name: tool, phase: 'result', input: value.input, output })
    } catch (cause) {
      failed = true
      output = { error: cause instanceof Error ? cause.message : 'client_tool_failed' }
      emit('tool', { name: tool, phase: 'error', input: value.input, output })
    }
    // The call arrives on the stream's `finish`; let that response close
    // before the result goes back, so the resume continues a settled message.
    await inFlight
    // A send while the tool ran settled the call as skipped; its run is gone,
    // so the result has nowhere to go.
    const stillWaiting = messages.value
      .at(-1)
      ?.parts.some(
        (part) =>
          isTool(part) &&
          part.toolCallId === toolCallId &&
          (part.state === 'input-available' ||
            (part.state === 'approval-responded' &&
              (part.approval as { approved?: boolean } | undefined)?.approved === true)),
      )
    if (stillWaiting)
      updateToolPart(toolCallId, (part) => ({
        ...part,
        state: 'output-available',
        output,
        ...(failed ? { isError: true } : {}),
      }))
    clientToolsRunning.value -= 1
    changed()
    if (stillWaiting && clientToolsRunning.value === 0 && lastStepSettled(messages.value.at(-1)))
      await track(request('submit-message'))
  }

  /**
   * Close every tool call still waiting on the visitor or the page: the run
   * behind it has expired, or a new message moved past it. The server settles
   * its own copy the same way, so a stale card cannot be answered and no chip
   * spins forever. `reason` becomes the chip's label.
   */
  function settleDangling(reason: 'expired' | 'skipped'): void {
    announcedRunId = undefined
    let changedAny = false
    const next = messages.value.map((message) => {
      if (message.role !== 'assistant') return message
      let touched = false
      const parts = message.parts.map((part) => {
        if (!isTool(part) || !DANGLING.has(String(part.state))) return part
        touched = true
        const { approval: _approval, ...rest } = part
        return { ...rest, state: 'output-error', errorText: reason }
      })
      if (!touched) return message
      changedAny = true
      return { ...message, parts }
    })
    if (changedAny) setMessages(next)
  }

  function updateToolPart(toolCallId: string, update: (part: UIPart) => UIPart): boolean {
    const current = messages.value
    const last = current.at(-1)
    if (!last?.parts.some((part) => isTool(part) && part.toolCallId === toolCallId)) return false
    setMessages([
      ...current.slice(0, -1),
      {
        ...last,
        parts: last.parts.map((part) =>
          isTool(part) && part.toolCallId === toolCallId ? update(part) : part,
        ),
      },
    ])
    return true
  }

  function setRetryAfter(seconds: number | undefined): void {
    if (retryTimer) clearInterval(retryTimer)
    retryTimer = undefined
    retryAfter.value = seconds
    if (!seconds) return
    retryTimer = setInterval(() => {
      const next = Math.max(0, (retryAfter.value ?? 1) - 1)
      retryAfter.value = next
      if (next === 0 && retryTimer) {
        clearInterval(retryTimer)
        retryTimer = undefined
      }
      changed()
    }, 1000)
  }

  function clearError(): void {
    error.value = undefined
    inlineError.value = undefined
    setRetryAfter(undefined)
    if (status.value === 'error') status.value = 'ready'
  }

  const controller: WidgetController = {
    options,
    config,
    get locale() {
      return hostLocale(config.ui, options.locale)
    },
    get suggestions() {
      return suggestionsLocale === undefined || suggestionsLocale === controller.locale
        ? runtimeSuggestions
        : undefined
    },
    setLocale(locale) {
      options.locale = locale
      changed()
    },
    get messages() {
      return messages.value
    },
    get state(): WidgetState {
      if (status.value === 'error') return 'error'
      if (clientToolsRunning.value > 0) return 'executing-client-tool'
      if (status.value !== 'ready') return status.value
      const last = messages.value.at(-1)
      return last && hasPendingApproval(last) ? 'awaiting-approval' : 'idle'
    },
    get error() {
      return error.value
    },
    get retryAfter() {
      return retryAfter.value
    },
    get composerDisabled() {
      return (retryAfter.value ?? 0) > 0 || error.value?.code === 'budget_exceeded'
    },
    get statusText() {
      return statusText.value && statusKey ? t()(statusKey) : statusText.value
    },
    get handoff() {
      return handoff.value
    },
    get inlineError() {
      return inlineError.value
    },
    get usage() {
      return usage.value
    },
    open() {},
    close() {},
    toggle() {},
    async send(text, sendOptions) {
      const value = text.trim()
      if (!value || controller.composerDisabled) return
      // docs/07 §7: sending while a run streams aborts it and starts anew.
      await settle()
      clearError()
      autoRetried = false
      lastSend = { text: value, hidden: sendOptions?.hidden }
      pageContext = await extractPageContext(config.ui, pageHash, customContext)
      // A new message abandons whatever run was waiting (docs/03 §2: resume
      // and a new message are mutually exclusive).
      settleDangling('skipped')
      const id = `m_${createSessionId().replace(/-/g, '')}`
      emit('message', { role: 'user', text: value, messageId: id })
      setMessages([
        ...messages.value,
        {
          id,
          role: 'user',
          parts: [{ type: 'text', text: value }],
          ...(sendOptions?.hidden ? { metadata: { hidden: true } } : {}),
        },
      ])
      await track(request('submit-message'))
    },
    stop() {
      abort?.abort()
    },
    async retry() {
      if ((retryAfter.value ?? 0) > 0) return
      await settle()
      const expired = error.value?.code === 'run_expired'
      clearError()
      autoRetried = false
      // docs/05 §7 rule 4: an expired run's Retry starts a fresh turn. The
      // timed-out call stays in view; the server settles it the same way and
      // the model picks up from there.
      if (expired) return track(request('regenerate'))
      const current = messages.value
      const lastUser = lastIndex(current, (message) => message.role === 'user')
      if (lastUser < 0) {
        if (lastSend) await controller.send(lastSend.text, { hidden: lastSend.hidden })
        return
      }
      // Regenerate: drop whatever the failed attempt produced after the user
      // turn and ask again. The server dedupes the user message by id.
      setMessages(current.slice(0, lastUser + 1))
      await track(request('regenerate'))
    },
    reset() {
      abort?.abort()
      messages.value = []
      identity = null
      customContext = {}
      runtimeSuggestions = undefined
      announcedRunId = undefined
      lastSend = undefined
      statusText.value = undefined
      handoff.value = undefined
      usage.value = undefined
      clearError()
      removeValue(sessionKey)
      removeValue(historyKey)
      sessionId = createSessionId()
      writeValue(sessionKey, sessionId, scope)
      status.value = 'ready'
      changed()
    },
    identify(jwt) {
      identity = jwt
    },
    clearIdentity() {
      identity = null
    },
    setContext(data) {
      customContext = { ...customContext, ...data }
      if (pageContext) pageContext = { ...pageContext, custom: customContext }
    },
    setSuggestions(items) {
      runtimeSuggestions = items
      suggestionsLocale = undefined
      changed()
    },
    rehydratePending(pending) {
      const approval = pending.approval
      const known = messages.value.some((message) =>
        message.parts.some(
          (part) => (part.approval as { id?: string } | undefined)?.id === approval.approvalId,
        ),
      )
      if (!known)
        setMessages([
          ...messages.value,
          {
            id: `pending-${pending.runId}`,
            role: 'assistant',
            parts: [
              { type: 'data-approval-request', data: { ...approval, runId: pending.runId } },
              {
                type: `tool-${approval.toolName}`,
                toolCallId: approval.toolCallId,
                state: 'approval-requested',
                input: approval.input,
                approval: { id: approval.approvalId },
              },
            ],
          },
        ])
      else changed()
    },
    expireStale() {
      // The server's session probe reported nothing pending, so a card the
      // history cache still shows has expired or been abandoned server-side.
      settleDangling('expired')
    },
    async refreshPageContext() {
      pageContext = await extractPageContext(config.ui, pageHash, customContext)
      return pageContext
    },
    registerTool(name, handler) {
      registerClientTool(registeredTools, name, handler)
    },
    unregisterTool(name) {
      unregisterClientTool(registeredTools, name)
    },
    async approve(approvalId, approved) {
      const last = messages.value.at(-1)
      const part = last?.parts.find(
        (candidate) => (candidate.approval as { id?: string } | undefined)?.id === approvalId,
      )
      if (!part || part.state !== 'approval-requested') return
      const toolName = typeof part.toolName === 'string' ? part.toolName : part.type.slice(5)
      emit('approval', { approvalId, toolName, decision: approved ? 'approve' : 'deny' })
      updateToolPart(String(part.toolCallId), (current) => ({
        ...current,
        state: 'approval-responded',
        approval: { id: approvalId, approved },
      }))
      // Resume once every approval in the step has an answer — docs/03 §5.
      if (lastStepSettled(messages.value.at(-1))) await track(request('submit-message'))
    },
    async feedback(messageId, rating) {
      emit('feedback', { messageId, rating })
      try {
        await fetch(`${options.endpoint.replace(/\/$/, '')}/feedback`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'accept-language': hostLocale(config.ui, options.locale),
            ...(options.publicKey ? { 'x-sitebot-key': options.publicKey } : {}),
          },
          body: JSON.stringify({ sessionId, messageId, rating }),
        })
      } catch {
        /* feedback never breaks the host */
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return controller
}

/**
 * Read a failed response into an error `normalizeError` understands: the
 * status and `Retry-After` matter as much as the body (docs/07 §10).
 */
async function responseError(response: Response): Promise<Error> {
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await response.json()
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch {
    /* not JSON — the status alone is enough */
  }
  const retryAfter = Number(response.headers.get('retry-after'))
  return new HttpError(response.status, body, Number.isFinite(retryAfter) ? retryAfter : undefined)
}

export class HttpError extends Error {
  override name = 'HttpError'
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly retryAfter?: number,
  ) {
    super(typeof body.code === 'string' ? body.code : `HTTP ${status}`)
  }
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

/**
 * Map whatever the request threw onto the fixed set of widget errors.
 *
 * The provider's own error text is never shown (docs/07 §10): the only
 * server-authored message that reaches the user is the one from the fixed
 * code table, and only for codes where it is actionable.
 */
export function normalizeError(cause: unknown, fallback: string): WidgetError {
  if (cause instanceof HttpError) {
    const code = typeof cause.body.code === 'string' ? cause.body.code : undefined
    if (cause.status === 429 || code === 'rate_limited')
      return {
        code: 'rate_limited',
        message: fallback,
        retryAfter: cause.retryAfter || 30,
        retryable: true,
      }
    if (cause.status === 402 || code === 'budget_exceeded')
      return { code: 'budget_exceeded', message: fallback, retryable: false }
    if (cause.status === 410) return { code: 'run_expired', message: fallback, retryable: true }
    if (code && CLIENT_CODES.has(code))
      return {
        code,
        ...(typeof cause.body.messageKey === 'string' && Object.hasOwn(en, cause.body.messageKey)
          ? {
              messageKey: cause.body.messageKey as MessageKey,
              values:
                typeof cause.body.values === 'object' && cause.body.values !== null
                  ? (Object.fromEntries(
                      Object.entries(cause.body.values).filter(
                        ([, value]) => typeof value === 'string' || typeof value === 'number',
                      ),
                    ) as Record<string, string | number>)
                  : undefined,
            }
          : {}),
        message: typeof cause.body.message === 'string' ? cause.body.message : fallback,
        retryable: false,
      }
    return { code: 'provider_error', message: fallback, retryable: true }
  }
  if (cause instanceof StreamError)
    return { code: 'provider_error', message: fallback, retryable: true }
  // `fetch` rejects with a TypeError on a network failure, and a body read
  // that dies mid-stream surfaces the same way.
  return { code: 'network', message: fallback, retryable: true }
}

const CLIENT_CODES = new Set([
  'auth_required',
  'origin_denied',
  'invalid_key',
  'payload_too_large',
  'invalid_request',
])

export function resumePayload(
  messages: UIMessage[],
  knownRunId: string | undefined,
  clientTools: string[],
):
  | {
      runId: string
      approvals?: Array<{ approvalId: string; decision: 'approve' | 'deny' }>
      clientToolResults?: Array<{ toolCallId: string; output: unknown }>
    }
  | undefined {
  const message = messages.at(-1)
  if (message?.role !== 'assistant') return undefined
  // The message's own run wins: a persisted `data-approval-request` names the
  // run exactly, whereas `knownRunId` is whatever the last stream announced.
  const runId = runIdFromMessage(message) ?? knownRunId
  if (!runId) return undefined
  const parts = lastStep(message) as Array<{
    type: string
    state?: string
    toolCallId?: string
    output?: unknown
    approval?: { id?: string; approved?: boolean }
  }>
  const approvals = parts
    .filter(
      (part) =>
        part.type.startsWith('tool-') &&
        part.state === 'approval-responded' &&
        typeof part.approval?.id === 'string',
    )
    .map((part) => ({
      approvalId: part.approval!.id!,
      decision: part.approval?.approved ? ('approve' as const) : ('deny' as const),
    }))
  const clientToolResults = parts
    .filter(
      (part) =>
        part.type.startsWith('tool-') &&
        part.state === 'output-available' &&
        typeof part.toolCallId === 'string' &&
        clientTools.includes(part.type.replace(/^tool-/, '')),
    )
    .map((part) => ({ toolCallId: part.toolCallId!, output: part.output }))
  if (approvals.length === 0 && clientToolResults.length === 0) return undefined
  return {
    runId,
    ...(approvals.length ? { approvals } : {}),
    ...(clientToolResults.length ? { clientToolResults } : {}),
  }
}

function lastStep(message: UIMessage): UIPart[] {
  const start = lastIndex(message.parts, (part) => part.type === 'step-start')
  return message.parts.slice(start + 1)
}

/** `Array.prototype.findLastIndex`, which the ES2022 browser baseline lacks. */
function lastIndex<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1)
    if (match(items[index] as T)) return index
  return -1
}

/** Nothing in the last step is still waiting on the user or the page. */
function lastStepSettled(message: UIMessage | undefined): boolean {
  if (message?.role !== 'assistant') return false
  return lastStep(message)
    .filter(isTool)
    .every((part) => part.state !== 'approval-requested' && part.state !== 'input-available')
}

function openVendorHandoff(data: HandoffData): void {
  try {
    const host = window as Window & {
      Intercom?: (...args: unknown[]) => void
      $crisp?: { push(value: unknown[]): void }
      zE?: (...args: unknown[]) => void
    }
    const kind = data.target?.kind
    if (kind === 'intercom' && host.Intercom) host.Intercom('showNewMessage', data.message)
    else if (kind === 'crisp' && host.$crisp) host.$crisp.push(['do', 'chat:open'])
    else if (kind === 'zendesk' && host.zE) host.zE('messenger', 'open')
  } catch {
    /* best effort */
  }
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('')
}

function runIdFromMessage(message: UIMessage): string | undefined {
  // A Retry can continue an assistant message with a fresh run. Its latest
  // data part wins over the timed-out run still visible earlier in the turn.
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]!
    if (part.type !== 'data-approval-request' && part.type !== 'data-client-tool-call') continue
    const runId = (part.data as { runId?: unknown } | undefined)?.runId
    if (typeof runId === 'string' && runId) return runId
  }
  return undefined
}

/** Tool states that wait on the visitor, the page, or a resume. */
const DANGLING = new Set(['approval-requested', 'approval-responded', 'input-available'])

function hasPendingApproval(message: UIMessage): boolean {
  return message.parts.some((part) => isTool(part) && part.state === 'approval-requested')
}
