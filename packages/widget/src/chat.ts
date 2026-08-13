import { signal } from '@preact/signals'
import {
  AbstractChat,
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type ChatInit,
  type ChatState,
  type UIMessage,
} from 'ai'
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
import type { PageContext, WidgetController, WidgetState } from './types.js'

class SignalChat extends AbstractChat<UIMessage> {
  constructor(init: Omit<ChatInit<UIMessage>, 'messages'> & { state: ChatState<UIMessage> }) {
    super(init)
  }
}

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
  const listeners = new Set<() => void>()
  const stateSignal = signal<WidgetState>('idle')
  const messagesSignal = signal<UIMessage[]>(
    config.ui.behaviour.persistHistory ? readMessages(historyKey) : [],
  )
  const errorSignal = signal<Error | undefined>(undefined)
  const retryAfterSignal = signal<number | undefined>(undefined)
  let lastSend: { text: string; hidden?: boolean } | undefined
  let retryTimer: number | undefined
  const registeredTools = new Map<string, ClientToolHandler>()
  let pendingRunId: string | undefined
  const changed = () => {
    if (config.ui.behaviour.persistHistory) writeMessages(historyKey, messagesSignal.value)
    notify()
    listeners.forEach((listener) => listener())
  }
  const emit = (type: string, detail?: unknown) =>
    options.onEvent?.({ type: type as never, detail })
  const state = {} as ChatState<UIMessage>
  Object.defineProperties(state, {
    status: {
      get: () => (stateSignal.value === 'idle' ? 'ready' : stateSignal.value),
      set: (value: string) => {
        stateSignal.value = value === 'ready' ? 'idle' : (value as WidgetState)
        changed()
      },
    },
    error: {
      get: () => errorSignal.value,
      set: (value: Error | undefined) => {
        errorSignal.value = value
        changed()
      },
    },
    messages: {
      get: () => messagesSignal.value,
      set: (value: UIMessage[]) => {
        messagesSignal.value = value
        changed()
      },
    },
  })
  state.pushMessage = (message) => {
    messagesSignal.value = [...messagesSignal.value, message]
    changed()
  }
  state.popMessage = () => {
    messagesSignal.value = messagesSignal.value.slice(0, -1)
    changed()
  }
  state.replaceMessage = (index, message) => {
    const next = [...messagesSignal.value]
    next[index] = message
    messagesSignal.value = next
    changed()
  }
  state.snapshot = (value) => structuredClone(value)

  const chat = new SignalChat({
    id: sessionId,
    state,
    transport: new DefaultChatTransport({
      api: options.endpoint,
      credentials: 'same-origin',
      prepareSendMessagesRequest: ({ messages, trigger, headers }) => {
        const resume = resumePayload(messages, pendingRunId, config.capabilities.clientTools)
        return {
          headers: {
            ...headers,
            ...(options.publicKey ? { 'x-sitebot-key': options.publicKey } : {}),
          },
          body: {
            sessionId,
            messages,
            trigger: resume ? 'resume' : trigger,
            ...(resume ? { resume } : {}),
            pageContext: pageContext ? { ...pageContext, custom: customContext } : pageContext,
            ...(identity ? { auth: identity } : {}),
          },
        }
      },
    }),
    sendAutomaticallyWhen: ({ messages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }) ||
      lastAssistantMessageIsCompleteWithToolCalls({ messages }),
    onData(data) {
      if (data.type === 'data-handoff') emit('handoff', data.data)
      if (data.type === 'data-approval-request') {
        pendingRunId = String((data.data as { runId?: unknown }).runId ?? '')
        stateSignal.value = 'awaiting-approval'
        changed()
        emit('approval', data.data)
      }
      if (data.type === 'data-client-tool-call') {
        const value = data.data as Record<string, unknown>
        pendingRunId = String(value.runId ?? '')
        const tool = String(value.toolName)
        stateSignal.value = 'executing-client-tool'
        emit('tool', { name: tool, phase: 'call', input: value.input })
        void runClientTool(tool, value.input, {
          config,
          pageContext: async () => pageContext,
          registered: registeredTools,
        })
          .then((output) => {
            emit('tool', { name: tool, phase: 'result', output })
            return chat.addToolOutput({ tool, toolCallId: String(value.toolCallId), output })
          })
          .catch((error: unknown) => {
            emit('tool', { name: tool, phase: 'error', output: error })
            return chat.addToolOutput({
              tool,
              toolCallId: String(value.toolCallId),
              output: { error: error instanceof Error ? error.message : 'client_tool_failed' },
            })
          })
      }
    },
    onError(error) {
      const normalized = normalizeError(error, config.ui.messages.errorMessage)
      errorSignal.value = new Error(normalized.message)
      retryAfterSignal.value = normalized.retryAfter
      if (retryTimer) clearInterval(retryTimer)
      if (normalized.retryAfter) {
        retryTimer = window.setInterval(() => {
          retryAfterSignal.value = Math.max(0, (retryAfterSignal.value ?? 1) - 1)
          if (retryAfterSignal.value === 0 && retryTimer) clearInterval(retryTimer)
          changed()
        }, 1000)
      }
      stateSignal.value = 'error'
      changed()
      emit('error', { code: normalized.code, message: normalized.message })
    },
    onFinish({ message }) {
      pendingRunId = pendingRunId ?? runIdFromMessage(message)
      stateSignal.value = hasPendingApproval(message) ? 'awaiting-approval' : 'idle'
      changed()
      const text = message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      if (text) emit('message', { role: 'assistant', text, messageId: message.id })
    },
  })

  return {
    options,
    config,
    get messages() {
      return messagesSignal.value
    },
    get state() {
      return stateSignal.value
    },
    get error() {
      return errorSignal.value
    },
    get retryAfter() {
      return retryAfterSignal.value
    },
    get composerDisabled() {
      return (
        Boolean(retryAfterSignal.value && retryAfterSignal.value > 0) ||
        errorSignal.value?.message.includes('budget') === true
      )
    },
    open() {},
    close() {},
    toggle() {},
    async send(text, sendOptions) {
      const value = text.trim()
      if (!value) return
      lastSend = { text: value, hidden: sendOptions?.hidden }
      if (chat.status === 'streaming' || chat.status === 'submitted') chat.stop()
      pageContext = await extractPageContext(config.ui, pageHash, customContext)
      pageHash = pageContext?.extractHash
      await chat.sendMessage({ text: value })
      const message = messagesSignal.value.at(-1)
      emit('message', { role: 'user', text: value, messageId: message?.id })
      if (sendOptions?.hidden && message?.role === 'user') {
        messagesSignal.value = messagesSignal.value.slice(0, -1)
        changed()
      }
    },
    stop() {
      chat.stop()
    },
    async retry() {
      if (!lastSend || (retryAfterSignal.value ?? 0) > 0) return
      errorSignal.value = undefined
      stateSignal.value = 'idle'
      await this.send(lastSend.text, { hidden: lastSend.hidden })
    },
    reset() {
      chat.stop()
      messagesSignal.value = []
      identity = null
      customContext = {}
      removeValue(sessionKey)
      removeValue(historyKey)
      sessionId = createSessionId()
      writeValue(sessionKey, sessionId, scope)
      stateSignal.value = 'idle'
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
      config.ui.messages.suggestions = items
      changed()
    },
    async refreshPageContext() {
      pageContext = await extractPageContext(config.ui, pageHash, customContext)
      pageHash = pageContext?.extractHash
      return pageContext
    },
    registerTool(name, handler) {
      registerClientTool(registeredTools, name, handler)
    },
    unregisterTool(name) {
      unregisterClientTool(registeredTools, name)
    },
    async approve(approvalId, approved) {
      stateSignal.value = 'submitted'
      await chat.addToolApprovalResponse({ id: approvalId, approved })
      emit('approval', { approvalId, decision: approved ? 'approve' : 'deny' })
      changed()
    },
    async feedback(messageId, rating) {
      try {
        await fetch(`${options.endpoint.replace(/\/$/, '')}/feedback`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...(options.publicKey ? { 'x-sitebot-key': options.publicKey } : {}),
          },
          body: JSON.stringify({ sessionId, messageId, rating }),
        })
        emit('feedback', { messageId, rating })
      } catch {
        /* feedback never breaks the host */
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function normalizeError(
  error: Error,
  fallback: string,
): { code: string; message: string; retryAfter?: number } {
  const source = `${error.name} ${error.message}`
  const retry = /retry[- ]after\D*(\d+)/i.exec(source)
  if (/429|rate[_ -]?limited/i.test(source))
    return { code: 'rate_limited', message: fallback, retryAfter: Number(retry?.[1] ?? 60) }
  if (/budget[_ -]?exceeded|402/i.test(source))
    return { code: 'budget_exceeded', message: fallback }
  return { code: 'provider_error', message: "I'm having trouble right now" }
}

function resumePayload(
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
  const runId = knownRunId || runIdFromMessage(message)
  if (!runId) return undefined
  const allParts = message.parts as Array<{
    type: string
    state?: string
    toolCallId?: string
    output?: unknown
    approval?: { id?: string; approved?: boolean }
  }>
  const lastStep = allParts.reduce(
    (index, part, current) => (part.type === 'step-start' ? current : index),
    -1,
  )
  const parts = allParts.slice(lastStep + 1)
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

function runIdFromMessage(message: UIMessage): string | undefined {
  for (const part of message.parts as Array<{ type: string; data?: unknown }>) {
    if (
      (part.type === 'data-approval-request' || part.type === 'data-client-tool-call') &&
      typeof part.data === 'object' &&
      part.data !== null &&
      typeof (part.data as { runId?: unknown }).runId === 'string'
    )
      return (part.data as { runId: string }).runId
  }
  return undefined
}
function hasPendingApproval(message: UIMessage): boolean {
  return (message.parts as Array<{ type: string; state?: string }>).some(
    (part) => part.type.startsWith('tool-') && part.state === 'approval-requested',
  )
}
