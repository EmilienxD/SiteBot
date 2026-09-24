import { Component, type ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { UIMessage } from './types.js'
import { Icon } from './icons.js'
import { Markdown } from './markdown.js'
import { createStrings, type Translate } from './strings.js'
import type { Citation, WidgetController } from './types.js'

/** `data-citations` part, as emitted by the engine's `appendCitations`. */
interface CitationsPart {
  type: 'data-citations'
  data: { items: Citation[] }
}
function isCitationsPart(part: unknown): part is CitationsPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'data-citations' &&
    Array.isArray((part as CitationsPart).data?.items)
  )
}

export interface PanelProps {
  controller: WidgetController
  close: () => void
  /** Set when `GET /config` failed at boot: the panel shows a retry state. */
  offline?: { retry: () => void }
  /** Rendered inside the `ui.isolation: iframe` frame, which positions it. */
  framed?: boolean
}

const MOBILE_QUERY = '(max-width: 639px)'

/** The panel's glyphs — in the lazy chunk, unlike the launcher's. */
const GLYPHS = {
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 18l-6-6 6-6',
  up: 'M12 19V5M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  thumbUp:
    'M7 10v11M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.5 21H7V10l4-8a3 3 0 0 1 4 3.9Z',
  thumbDown:
    'M17 14V3M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-7A2 2 0 0 1 5.5 3H17v11l-4 8a3 3 0 0 1-4-3.9Z',
  attach:
    'm21 12-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.3l8-8',
} as const

export function Panel({ controller, close, offline, framed }: PanelProps) {
  const [, redraw] = useState(0)
  const [input, setInput] = useState('')
  const [follow, setFollow] = useState(true)
  const [working, setWorking] = useState(false)
  const [ratings, setRatings] = useState<Record<string, 'up' | 'down'>>({})
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const lastScrollTop = useRef(0)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const ui = controller.config.ui
  const t = useMemo(() => createStrings(ui), [ui])
  const [emptyVisible, setEmptyVisible] = useState(ui.messages.emptyStateAfterMs === 0)
  const mobile = useMediaQuery(MOBILE_QUERY)

  useEffect(() => controller.subscribe(() => redraw((value) => value + 1)), [controller])
  // docs/07 §8: focus moves to the composer on open.
  useLayoutEffect(() => {
    textarea.current?.focus()
  }, [])
  useEffect(() => {
    if (follow && list.current?.scrollTo) list.current.scrollTo({ top: list.current.scrollHeight })
  }, [controller.messages, controller.state, follow])
  // docs/07 §6/§8: the mobile sheet is modal — body scroll locked, focus held.
  useLayoutEffect(() => {
    if (!mobile) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [mobile])
  // docs/07 §7: "if no token arrives within 4 s it adds 'Still working…'".
  useEffect(() => {
    if (controller.state !== 'submitted') {
      setWorking(false)
      return
    }
    const timer = setTimeout(() => setWorking(true), 4000)
    return () => clearTimeout(timer)
  }, [controller.state])
  useEffect(() => {
    if (controller.messages.length > 0 || emptyVisible) return
    const timer = setTimeout(() => setEmptyVisible(true), ui.messages.emptyStateAfterMs)
    return () => clearTimeout(timer)
  }, [controller.messages.length, emptyVisible, ui.messages.emptyStateAfterMs])
  const assistantCount = controller.messages.filter(
    (message) => message.role === 'assistant',
  ).length
  const previousAssistantCount = useRef(assistantCount)
  useEffect(() => {
    if (ui.behaviour.sound && assistantCount > previousAssistantCount.current) playNotification()
    previousAssistantCount.current = assistantCount
  }, [assistantCount, ui.behaviour.sound])

  const state = controller.state
  const busy = state === 'submitted' || state === 'streaming' || state === 'executing-client-tool'
  const disabled = controller.composerDisabled || offline !== undefined
  const visible = controller.messages.filter(
    (message) =>
      message.role !== 'system' &&
      (message.metadata as { hidden?: boolean } | undefined)?.hidden !== true,
  )
  const lastUserText = [...visible]
    .reverse()
    .find((message) => message.role === 'user')
    ?.parts.map((part) => (part.type === 'text' ? String(part.text ?? '') : ''))
    .join('')

  const send = () => {
    const value = input.trim()
    if (!value || disabled) return
    setInput('')
    setFollow(true)
    resize(textarea.current, '')
    void controller.send(value)
  }
  const suggestions =
    ui.messages.suggestionsPersist || !visible.some((message) => message.role === 'user')
      ? ui.messages.suggestions
      : []
  const greeting = t('greeting')
  const name = controller.config.name ?? 'Assistant'
  const avatar = <Avatar url={ui.panel.avatarUrl} name={name} />

  return (
    <div
      ref={panel}
      class={`panel${ui.position === 'bottom-left' ? ' left' : ''}${framed ? ' framed' : ''}`}
      role="dialog"
      aria-modal={mobile ? 'true' : 'false'}
      aria-label={ui.a11y.panelAriaLabel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // docs/07 §5: Escape blurs a composer with content before closing.
          const target = event.target as HTMLElement
          if (target === textarea.current && input) target.blur()
          else close()
          event.stopPropagation()
          return
        }
        if (mobile) trapFocus(event, panel.current)
      }}
    >
      <header class="header">
        <button type="button" class="icon-button back" aria-label={t('back')} onClick={close}>
          <Icon d={GLYPHS.back} />
        </button>
        {ui.panel.showAvatar && avatar}
        <div class="title">{ui.panel.title ?? name}</div>
        {ui.panel.showClose && (
          <button type="button" class="icon-button close" aria-label={t('close')} onClick={close}>
            <Icon d={GLYPHS.close} />
          </button>
        )}
      </header>
      <div class="divider" />
      <div
        class="messages"
        ref={list}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={busy}
        onScroll={() => {
          const node = list.current
          if (!node) return
          // docs/07 §5: follow only while within 40 px of the bottom. Only an
          // upward scroll cancels follow — layout settling and our own
          // scroll-to-bottom also fire scroll events, and must not.
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 40
          const scrolledUp = node.scrollTop < lastScrollTop.current
          lastScrollTop.current = node.scrollTop
          if (atBottom) setFollow(true)
          else if (scrolledUp) setFollow(false)
        }}
      >
        {offline ? (
          <div class="offline" role="alert">
            {t('offline')}
            <button type="button" class="button" onClick={offline.retry}>
              {t('retry')}
            </button>
          </div>
        ) : (
          greeting &&
          emptyVisible &&
          visible.length === 0 && (
            <Message role="assistant">
              <div class="bubble">
                <Markdown text={greeting} />
              </div>
              <div class="attribution">
                {ui.panel.showAvatar && avatar}
                {name}
              </div>
            </Message>
          )
        )}
        {visible.map((message, index) => {
          const next = visible[index + 1]
          const lastInRun = message.role === 'assistant' && next?.role !== 'assistant'
          const streaming = busy && index === visible.length - 1 && message.role === 'assistant'
          return (
            <MessageView
              key={message.id}
              message={message}
              previousRole={visible[index - 1]?.role}
              controller={controller}
              t={t}
              streaming={streaming}
              attribution={
                lastInRun ? (
                  <div class="attribution">
                    {ui.panel.showAvatar && avatar}
                    {name}
                  </div>
                ) : null
              }
              rating={ratings[message.id]}
              rate={
                lastInRun && !streaming && !message.id.startsWith('pending-')
                  ? (rating) => {
                      setRatings((current) => ({ ...current, [message.id]: rating }))
                      void controller.feedback(message.id, rating)
                    }
                  : undefined
              }
            />
          )
        })}
        {state === 'submitted' && ui.behaviour.showTypingIndicator && (
          <div class="message assistant">
            <div class="bubble typing" role="status" aria-label={t('typing')}>
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        {controller.statusText && busy && <div class="status">{controller.statusText}</div>}
        {working && <div class="status">{t('stillWorking')}</div>}
        {state === 'error' && <ErrorBubble controller={controller} t={t} />}
        {controller.inlineError && state !== 'error' && (
          <div class="error inline-error" role="alert">
            {t('providerError')}
            {controller.inlineError.retryable && !busy && (
              <button type="button" class="button" onClick={() => void controller.retry()}>
                {t('retry')}
              </button>
            )}
          </div>
        )}
        {controller.handoff && <HandoffCard data={controller.handoff} t={t} />}
        {controller.usage && (
          <details class="usage">
            <summary>Usage</summary>
            {controller.usage.inputTokens} in / {controller.usage.outputTokens} out / $
            {controller.usage.costUsd.toFixed(4)}
          </details>
        )}
      </div>
      {!follow && (
        <button
          type="button"
          class="jump"
          onClick={() => {
            setFollow(true)
            list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })
          }}
        >
          ↓ {t('jumpToLatest')}
        </button>
      )}
      {suggestions.length > 0 && !offline && (
        <div class="suggestions">
          {suggestions.map((item) => (
            <button
              key={item.label}
              type="button"
              class="suggestion"
              onClick={() => runSuggestion(item.action, controller)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div class="composer-wrap">
        <div class="composer">
          <label class="sr" for="sitebot-message">
            {t('message')}
          </label>
          <textarea
            id="sitebot-message"
            ref={textarea}
            rows={1}
            value={input}
            placeholder={t('placeholder')}
            disabled={disabled}
            onInput={(event) => {
              setInput(event.currentTarget.value)
              resize(event.currentTarget, event.currentTarget.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                send()
              } else if (event.key === 'ArrowUp' && !input && lastUserText) {
                // docs/07 §5: ↑ on an empty composer recalls the last message.
                event.preventDefault()
                setInput(lastUserText)
                resize(event.currentTarget, lastUserText)
              }
            }}
          />
          {ui.behaviour.allowFileUpload && controller.config.capabilities.fileUpload && (
            <label class="attach" aria-label={t('attachFile')}>
              <Icon d={GLYPHS.attach} />
              <input type="file" hidden />
            </label>
          )}
          <button
            type="button"
            class="send"
            aria-label={busy ? t('stop') : t('send')}
            disabled={!busy && (!input.trim() || disabled)}
            onClick={() => (busy ? controller.stop() : send())}
          >
            <Icon d={busy ? GLYPHS.stop : GLYPHS.up} size={busy ? 14 : 18} filled={busy} />
          </button>
        </div>
      </div>
      {ui.footer?.text && (
        <div class="footer">
          {ui.footer.text}{' '}
          {ui.footer.linkText && ui.footer.linkUrl && (
            <a href={ui.footer.linkUrl} target="_blank" rel="noopener noreferrer">
              {ui.footer.linkText}
            </a>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * docs/07 §10: "JS error inside the widget — error boundary renders a minimal
 * recovery UI; the host page is never affected."
 */
export class PanelBoundary extends Component<
  { children: ComponentChildren; close: () => void },
  { failed: boolean }
> {
  override state = { failed: false }
  override componentDidCatch(error: unknown): void {
    console.warn('[SiteBot] the chat panel crashed and was contained', error)
    this.setState({ failed: true })
  }
  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div class="panel" role="dialog" aria-label="Chat assistant">
        <div class="offline" role="alert">
          Something went wrong.
          <button type="button" class="button" onClick={() => this.setState({ failed: false })}>
            Retry
          </button>
          <button type="button" class="button" onClick={this.props.close}>
            Close
          </button>
        </div>
      </div>
    )
  }
}

function Avatar({ url, name }: { url?: string | undefined; name: string }) {
  return (
    <div class="avatar" aria-hidden="true">
      {url ? <img src={url} alt="" /> : name.slice(0, 1).toUpperCase()}
    </div>
  )
}

function Message({
  role,
  previousRole,
  children,
}: {
  role: UIMessage['role']
  previousRole?: UIMessage['role'] | undefined
  children: ComponentChildren
}) {
  return (
    <div class={`message ${role} ${previousRole === role ? 'same-role' : 'role-change'}`}>
      {children}
    </div>
  )
}

function MessageView({
  message,
  previousRole,
  controller,
  t,
  streaming,
  attribution,
  rating,
  rate,
}: {
  message: UIMessage
  previousRole?: UIMessage['role'] | undefined
  controller: WidgetController
  t: Translate
  streaming: boolean
  attribution: ComponentChildren
  rating?: 'up' | 'down' | undefined
  rate?: ((rating: 'up' | 'down') => void) | undefined
}) {
  const ui = controller.config.ui
  const text = messageText(message)
  const citations = citationList(message, text)
  const approvalData = approvalRequests(message)
  const markdown = message.role === 'assistant' && ui.behaviour.markdown
  // Parts render in stream order — "Let me check… [tool] It ships today." —
  // with consecutive text parts sharing one bubble. Collapsing every text part
  // into a single bubble after the chips would reorder the conversation.
  const blocks: ComponentChildren[] = []
  let run: string[] = []
  // The streaming caret goes on the final text run only, and only while the
  // message is still streaming.
  const flush = (key: string, final = false) => {
    const joined = run.join('')
    run = []
    if (joined.trim() === '') return
    blocks.push(
      <div class={`bubble${final && streaming ? ' streaming-caret' : ''}`} key={key}>
        {markdown ? <Markdown text={joined} /> : joined}
      </div>,
    )
  }
  message.parts.forEach((part, index) => {
    if (part.type === 'text') {
      run.push(String(part.text ?? ''))
      return
    }
    if (
      part.type === 'step-start' ||
      part.type.startsWith('data-') ||
      part.type.startsWith('source-')
    )
      return
    flush(`text-${index}`)
    if (part.type === 'reasoning') {
      if (ui.behaviour.showReasoning && part.text)
        blocks.push(
          <details class="reasoning" key={index}>
            <summary>{t('thinking')}</summary>
            <div>{String(part.text)}</div>
          </details>,
        )
    } else if (isApprovalPart(part)) {
      const request = approvalData.get(part.approval.id) ?? approvalData.get(part.toolCallId)
      blocks.push(
        <ApprovalCard
          key={part.approval.id}
          part={part}
          request={request}
          t={t}
          approve={(approved) => void controller.approve(part.approval.id, approved)}
        />,
      )
    } else if (isToolPart(part)) blocks.push(<ToolChip key={index} part={part} t={t} />)
  })
  flush('text-end', true)
  return (
    <Message role={message.role} previousRole={previousRole}>
      {blocks}
      {citations.length > 0 && (
        <CitationRow
          citations={citations}
          t={t}
          onClick={(citation) => controller.clickCitation?.(citation)}
        />
      )}
      {attribution}
      {rate && text && (
        <div class={`feedback${rating ? ' rated' : ''}`}>
          <button
            type="button"
            aria-label={t('helpful')}
            aria-pressed={rating === 'up'}
            onClick={() => rate('up')}
          >
            <Icon d={GLYPHS.thumbUp} size={15} />
          </button>
          <button
            type="button"
            aria-label={t('notHelpful')}
            aria-pressed={rating === 'down'}
            onClick={() => rate('down')}
          >
            <Icon d={GLYPHS.thumbDown} size={15} />
          </button>
        </div>
      )}
    </Message>
  )
}

function ErrorBubble({ controller, t }: { controller: WidgetController; t: Translate }) {
  const error = controller.error
  const code = error?.code
  const message =
    code === 'rate_limited' || code === 'network'
      ? t('errorMessage')
      : code === 'budget_exceeded'
        ? t('budgetExceeded')
        : code === 'run_expired'
          ? t('runExpired')
          : code === 'provider_error' || error === undefined
            ? t('providerError')
            : error.message
  const retryable = error === undefined || error.retryable
  return (
    <div class="error" role="alert">
      <span>{message}</span>
      {controller.retryAfter ? (
        <span class="retry-countdown">{t('retryIn', { seconds: controller.retryAfter })}</span>
      ) : (
        retryable && (
          <button type="button" class="button" onClick={() => void controller.retry()}>
            {t('retry')}
          </button>
        )
      )}
    </div>
  )
}

function HandoffCard({
  data,
  t,
}: {
  data: NonNullable<WidgetController['handoff']>
  t: Translate
}) {
  const target = String(data.target?.kind ?? 'support')
  return (
    <div class="card handoff-card" role="status">
      <strong>{t('handoff', { target })}</strong>
      <p>{data.message}</p>
      {data.ticketUrl && (
        <a href={data.ticketUrl} target="_blank" rel="noopener noreferrer">
          {t('openHandoff')}
        </a>
      )}
    </div>
  )
}

/**
 * Numbered source chips under an assistant bubble — docs/06 §3.9 rule 5.
 * The `data-citations` part carries every retrieval hit; the widget shows only
 * those the model actually cited (`[n]` in the text), which is what keeps the
 * UI honest when retrieval surfaced context the model did not use.
 */
export function citationList(message: UIMessage, text: string): Citation[] {
  const part = (message.parts as unknown[]).find(isCitationsPart)
  if (part === undefined) return []
  const used = new Set<number>()
  for (const match of text.matchAll(/\[(\d+)\]/g)) used.add(Number(match[1]))
  // No visible markers (e.g. tool-only answer): still render the sources the
  // engine attached — the intent of `includeCitations` is transparency, and
  // hiding them because the model phrased around [n] would surprise a dev.
  if (used.size === 0) return part.data.items
  return part.data.items.filter((_, index) => used.has(index + 1))
}

function CitationRow({
  citations,
  t,
  onClick,
}: {
  citations: Citation[]
  t: Translate
  onClick: (citation: Citation) => void
}) {
  return (
    <div class="citations" role="group" aria-label={t('sources')}>
      {citations.map((citation, index) => (
        <button
          key={citation.id}
          type="button"
          class="citation-chip"
          title={citation.snippet || citation.title}
          aria-label={t('source', { n: index + 1, title: citation.title })}
          onClick={() => onClick(citation)}
        >
          <span class="citation-n">{index + 1}</span>
          <span class="citation-title">{citation.title}</span>
        </button>
      ))}
    </div>
  )
}

type ToolPart = {
  type: string
  state?: string
  toolName?: string
  toolCallId?: string
  errorText?: string
}
type ApprovalPart = ToolPart & { toolCallId: string; approval: { id: string }; input?: unknown }
interface ApprovalRequest {
  approvalId?: string
  toolCallId?: string
  toolName?: string
  title?: string
  description?: string
  risk?: 'low' | 'medium' | 'high'
}

function isToolPart(part: unknown): part is ToolPart {
  if (typeof part !== 'object' || part === null) return false
  const type = (part as { type?: unknown }).type
  return typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')
}
function isApprovalPart(part: unknown): part is ApprovalPart {
  return (
    isToolPart(part) &&
    part.state === 'approval-requested' &&
    typeof (part as ApprovalPart).approval?.id === 'string'
  )
}
function toolName(part: ToolPart): string {
  return part.toolName ?? part.type.replace(/^tool-/, '')
}
/** `data-approval-request` parts, keyed by approval id and tool call id. */
function approvalRequests(message: UIMessage): Map<string, ApprovalRequest> {
  const found = new Map<string, ApprovalRequest>()
  for (const part of message.parts as Array<{ type: string; data?: ApprovalRequest }>) {
    if (part.type !== 'data-approval-request' || !part.data) continue
    if (part.data.approvalId) found.set(part.data.approvalId, part.data)
    if (part.data.toolCallId) found.set(part.data.toolCallId, part.data)
  }
  return found
}

function ToolChip({ part, t }: { part: ToolPart; t: Translate }) {
  const failed = part.state === 'output-error'
  const done = part.state === 'output-available' || part.state === 'output-denied'
  return (
    <div class={`tool-chip${failed ? ' error' : ''}`} role="status">
      {!done && !failed && <span class="spinner" aria-hidden="true" />}
      <strong>{humanize(toolName(part))}</strong>
      <span>{failed ? t('toolFailed') : done ? t('toolDone') : t('toolRunning')}</span>
    </div>
  )
}

function ApprovalCard({
  part,
  request,
  t,
  approve,
}: {
  part: ApprovalPart
  request?: ApprovalRequest | undefined
  t: Translate
  approve: (approved: boolean) => void
}) {
  const card = useRef<HTMLDivElement>(null)
  // docs/07 §8: the card takes focus, and Approve is *not* the default action
  // — focus lands on Deny, so a stray Enter declines rather than acts.
  useEffect(() => {
    card.current?.querySelector<HTMLButtonElement>('button.deny')?.focus()
  }, [])
  const name = humanize(request?.toolName ?? toolName(part))
  const risk = request?.risk
  return (
    <div
      ref={card}
      class="card approval-card"
      role="alertdialog"
      aria-modal="true"
      aria-label={`${t('approvalTitle')}: ${name}`}
      onKeyDown={(event) => trapFocus(event, card.current)}
    >
      <strong>{request?.title ?? t('approvalTitle')}</strong>
      {risk && <span class={`risk ${risk}`}>{risk}</span>}
      <p>{request?.description ?? t('approvalBody', { tool: name })}</p>
      <details>
        <summary>{t('details')}</summary>
        <pre>{JSON.stringify(part.input ?? {}, null, 2)}</pre>
      </details>
      <div class="card-actions">
        <button type="button" class="button deny" onClick={() => approve(false)}>
          {t('deny')}
        </button>
        <button type="button" class="button primary" onClick={() => approve(true)}>
          {t('approve')}
        </button>
      </div>
    </div>
  )
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('')
}

function humanize(name: string): string {
  const spaced = name.replace(/^[a-z0-9]+__/, '').replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function resize(node: HTMLTextAreaElement | null, value: string): void {
  if (!node) return
  node.value = value
  node.style.height = 'auto'
  node.style.height = `${node.scrollHeight}px`
}

function runSuggestion(
  action: WidgetController['config']['ui']['messages']['suggestions'][number]['action'],
  controller: WidgetController,
): void {
  try {
    if (action.type === 'send') void controller.send(action.text)
    else if (action.type === 'navigate' && action.path.startsWith('/')) location.assign(action.path)
    else if (action.type === 'tool')
      void controller.send(
        `Use the ${action.tool} tool with input ${JSON.stringify(action.input ?? {})}`,
        { hidden: true },
      )
    else if (action.type === 'link') window.open(action.url, '_blank', 'noopener,noreferrer')
  } catch (error) {
    console.warn('[SiteBot] suggestion action failed', error)
  }
}

function useMediaQuery(query: string): boolean {
  const read = () => typeof matchMedia === 'function' && matchMedia(query).matches
  const [matches, setMatches] = useState(read)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const list = matchMedia(query)
    const update = () => setMatches(list.matches)
    list.addEventListener?.('change', update)
    return () => list.removeEventListener?.('change', update)
  }, [query])
  return matches
}

function playNotification(): void {
  try {
    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) return
    const context = new AudioContextClass()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    gain.gain.value = 0.03
    oscillator.frequency.value = 660
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.08)
  } catch {
    /* sound is best effort */
  }
}

function trapFocus(event: KeyboardEvent, root: HTMLElement | null): void {
  if (event.key !== 'Tab' || root === null) return
  const focusable = [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]),textarea:not([disabled]),summary,[href],[tabindex]:not([tabindex="-1"])',
    ),
  ]
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable.at(-1)
  const active = (root.getRootNode() as Document | ShadowRoot).activeElement
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first?.focus()
  }
}
