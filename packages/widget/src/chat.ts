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
  let pageContext: PageContext | null = null
  let pageHash: string | undefined
  const listeners = new Set<() => void>()
  const stateSignal = signal<WidgetState>('idle')
  const messagesSignal = signal<UIMessage[]>(
    config.ui.behaviour.persistHistory ? readMessages(historyKey) : [],
  )
  const errorSignal = signal<Error | undefined>(undefined)
  const registeredTools = new Map<string, ClientToolHandler>()
  let pendingRunId: string | undefined
  const changed = () => {
    if (config.ui.behaviour.persistHistory) writeMessages(historyKey, messagesSignal.value)
    notify()
    listeners.forEach((listener) => listener())
  }
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
            pageContext,
            ...(identity ? { auth: identity } : {}),
          },
        }
      },
    }),
    sendAutomaticallyWhen: ({ messages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }) ||
      lastAssistantMessageIsCompleteWithToolCalls({ messages }),
    onData(data) {
      if (data.type === 'data-approval-request') {
        pendingRunId = String((data.data as { runId?: unknown }).runId ?? '')
        stateSignal.value = 'awaiting-approval'
        changed()
      }
      if (data.type === 'data-client-tool-call') {
        const value = data.data as Record<string, unknown>
        pendingRunId = String(value.runId ?? '')
        const tool = String(value.toolName)
        void runClientTool(tool, value.input, {
          config,
          pageContext: async () => pageContext,
          registered: registeredTools,
        })
          .then((output) =>
            chat.addToolOutput({ tool, toolCallId: String(value.toolCallId), output }),
          )
          .catch((error: unknown) =>
            chat.addToolOutput({
              tool,
              toolCallId: String(value.toolCallId),
              output: { error: error instanceof Error ? error.message : 'client_tool_failed' },
            }),
          )
      }
    },
    onError(error) {
      errorSignal.value = error
      stateSignal.value = 'error'
      changed()
    },
    onFinish({ message }) {
      pendingRunId = pendingRunId ?? runIdFromMessage(message)
      stateSignal.value = hasPendingApproval(message) ? 'awaiting-approval' : 'idle'
      changed()
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
    open() {},
    close() {},
    toggle() {},
    async send(text) {
      const value = text.trim()
      if (!value) return
      if (chat.status === 'streaming' || chat.status === 'submitted') chat.stop()
      pageContext = await extractPageContext(config.ui, pageHash)
      pageHash = pageContext?.extractHash
      await chat.sendMessage({ text: value })
    },
    stop() {
      chat.stop()
    },
    reset() {
      chat.stop()
      messagesSignal.value = []
      identity = null
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
    async refreshPageContext() {
      pageContext = await extractPageContext(config.ui, pageHash)
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
      changed()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
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
