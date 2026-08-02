import { signal } from '@preact/signals'
import { AbstractChat, DefaultChatTransport, type ChatInit, type ChatState, type UIMessage } from 'ai'
import type { PublicConfig } from '@sitebot/config'
import { extractPageContext } from './context.js'
import { createSessionId, readMessages, readValue, removeValue, storageKey, writeMessages, writeValue } from './storage.js'
import type { PageContext, WidgetController, WidgetState } from './types.js'

class SignalChat extends AbstractChat<UIMessage> {
  constructor(init: Omit<ChatInit<UIMessage>, 'messages'> & { state: ChatState<UIMessage> }) { super(init) }
}

export function createController(options: WidgetController['options'], config: PublicConfig, notify: () => void): WidgetController {
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
  const messagesSignal = signal<UIMessage[]>(config.ui.behaviour.persistHistory ? readMessages(historyKey) : [])
  const errorSignal = signal<Error | undefined>(undefined)
  const changed = () => { if (config.ui.behaviour.persistHistory) writeMessages(historyKey, messagesSignal.value); notify(); listeners.forEach((listener) => listener()) }
  const state = {} as ChatState<UIMessage>
  Object.defineProperties(state, {
    status: { get: () => stateSignal.value === 'idle' ? 'ready' : stateSignal.value, set: (value: string) => { stateSignal.value = value === 'ready' ? 'idle' : value as WidgetState; changed() } },
    error: { get: () => errorSignal.value, set: (value: Error | undefined) => { errorSignal.value = value; changed() } },
    messages: { get: () => messagesSignal.value, set: (value: UIMessage[]) => { messagesSignal.value = value; changed() } },
  })
  state.pushMessage = (message) => { messagesSignal.value = [...messagesSignal.value, message]; changed() }
  state.popMessage = () => { messagesSignal.value = messagesSignal.value.slice(0, -1); changed() }
  state.replaceMessage = (index, message) => { const next = [...messagesSignal.value]; next[index] = message; messagesSignal.value = next; changed() }
  state.snapshot = (value) => structuredClone(value)

  const chat = new SignalChat({
    id: sessionId, state,
    transport: new DefaultChatTransport({ api: options.endpoint, credentials: 'same-origin', prepareSendMessagesRequest: ({ messages, trigger, headers }) => ({ headers: { ...headers, ...(options.publicKey ? { 'x-sitebot-key': options.publicKey } : {}) }, body: { sessionId, messages, trigger, pageContext, ...(identity ? { auth: identity } : {}) } }) }),
    onError(error) { errorSignal.value = error; stateSignal.value = 'error'; changed() },
    onFinish() { stateSignal.value = 'idle'; changed() },
  })

  return {
    options, config,
    get messages() { return messagesSignal.value }, get state() { return stateSignal.value }, get error() { return errorSignal.value },
    open() {}, close() {}, toggle() {},
    async send(text) { const value = text.trim(); if (!value) return; if (chat.status === 'streaming' || chat.status === 'submitted') chat.stop(); pageContext = await extractPageContext(config.ui, pageHash); pageHash = pageContext?.extractHash; await chat.sendMessage({ text: value }) },
    stop() { chat.stop() },
    reset() { chat.stop(); messagesSignal.value = []; identity = null; removeValue(sessionKey); removeValue(historyKey); sessionId = createSessionId(); writeValue(sessionKey, sessionId, scope); stateSignal.value = 'idle'; changed() },
    identify(jwt) { identity = jwt },
    async refreshPageContext() { pageContext = await extractPageContext(config.ui, pageHash); pageHash = pageContext?.extractHash; return pageContext },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}
