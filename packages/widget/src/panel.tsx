import { useEffect, useRef, useState } from 'preact/hooks'
import type { UIMessage } from 'ai'
import { Markdown } from './markdown.js'
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

export function Panel({ controller, close }: { controller: WidgetController; close: () => void }) {
  const [, redraw] = useState(0)
  const [input, setInput] = useState('')
  const [follow, setFollow] = useState(true)
  const list = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const ui = controller.config.ui

  useEffect(() => controller.subscribe(() => redraw((value) => value + 1)), [controller])
  useEffect(() => {
    textarea.current?.focus()
  }, [])
  useEffect(() => {
    if (follow) list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [controller.messages, controller.state, follow])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    addEventListener('keydown', escape)
    return () => removeEventListener('keydown', escape)
  }, [close])

  const busy = controller.state === 'submitted' || controller.state === 'streaming'
  const send = async () => {
    const value = input.trim()
    if (!value) return
    setInput('')
    await controller.send(value)
  }
  const suggestions =
    ui.messages.suggestionsPersist ||
    !controller.messages.some((message) => message.role === 'user')
      ? ui.messages.suggestions
      : []

  return (
    <div
      class={`panel ${ui.position === 'bottom-left' ? 'left' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label={ui.a11y.panelAriaLabel}
    >
      <header class="header">
        {ui.panel.showAvatar && (
          <div class="avatar">
            {ui.panel.avatarUrl ? (
              <img src={ui.panel.avatarUrl} alt="" />
            ) : (
              (controller.config.name ?? 'A').slice(0, 1)
            )}
          </div>
        )}
        <div class="title">{ui.panel.title ?? controller.config.name ?? 'Assistant'}</div>
        {ui.panel.showClose && (
          <button class="icon-button" aria-label="Close chat" onClick={close}>
            ✕
          </button>
        )}
      </header>
      <div
        class="messages"
        ref={list}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={() => {
          const node = list.current
          if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 72)
        }}
      >
        {ui.messages.greeting && controller.messages.length === 0 && (
          <Message
            role="assistant"
            text={ui.messages.greeting}
            attribution={controller.config.name}
            markdown={ui.behaviour.markdown}
          />
        )}
        {controller.messages.map((message) => (
          <Message
            key={message.id}
            role={message.role}
            text={messageText(message)}
            attribution={message.role === 'assistant' ? controller.config.name : undefined}
            markdown={ui.behaviour.markdown}
            controller={controller}
            message={message}
          />
        ))}
        {controller.messages
          .flatMap((message) => message.parts)
          .filter(isToolPart)
          .map((part, index) => (
            <ToolChip key={index} part={part} />
          ))}
        {controller.messages
          .flatMap((message) => message.parts)
          .filter((part) => isApprovalPart(part))
          .map((part) => {
            const approval = part as unknown as ApprovalPart
            return (
              <ApprovalCard
                key={approval.approval.id}
                part={approval}
                approve={(approved) => void controller.approve(approval.approval.id, approved)}
              />
            )
          })}
        {busy && ui.behaviour.showTypingIndicator && (
          <div class="message assistant">
            <div class="bubble typing" aria-label="Assistant is typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        {controller.state === 'error' && (
          <div class="error" role="alert">
            {ui.messages.errorMessage}
          </div>
        )}
      </div>
      {!follow && (
        <button
          class="jump"
          onClick={() => {
            setFollow(true)
            list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })
          }}
        >
          ↓ Latest
        </button>
      )}
      {suggestions.length > 0 && (
        <div class="suggestions">
          {suggestions.map((item) => (
            <button class="suggestion" onClick={() => suggestion(item.action, controller)}>
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div class="composer-wrap">
        <div class="composer">
          <label class="sr" for="sitebot-message">
            Message
          </label>
          <textarea
            id="sitebot-message"
            ref={textarea}
            rows={1}
            value={input}
            placeholder={ui.messages.placeholder}
            onInput={(event) => {
              const target = event.currentTarget
              setInput(target.value)
              target.style.height = 'auto'
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <button
            class="send"
            aria-label={busy ? 'Stop response' : 'Send message'}
            disabled={!busy && !input.trim()}
            onClick={() => (busy ? controller.stop() : void send())}
          >
            {busy ? '■' : '↑'}
          </button>
        </div>
      </div>
      {ui.footer?.text && (
        <div class="footer">
          {ui.footer.text}{' '}
          {ui.footer.linkText && ui.footer.linkUrl && (
            <a href={ui.footer.linkUrl}>{ui.footer.linkText}</a>
          )}
        </div>
      )}
    </div>
  )
}

function Message({
  role,
  text,
  attribution,
  markdown,
  controller,
  message,
}: {
  role: UIMessage['role']
  text: string
  attribution?: string
  markdown: boolean
  controller?: WidgetController
  message?: UIMessage
}) {
  if (!text || role === 'system') return null
  const citations = message === undefined ? [] : citationList(message, text)
  return (
    <div class={`message ${role}`}>
      <div class="bubble">{markdown ? <Markdown text={text} /> : text}</div>
      {citations.length > 0 && (
        <CitationRow
          citations={citations}
          onClick={(citation) => controller?.clickCitation?.(citation)}
        />
      )}
      {attribution && <div class="attribution">{attribution}</div>}
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
  onClick,
}: {
  citations: Citation[]
  onClick: (citation: Citation) => void
}) {
  return (
    <div class="citations" role="group" aria-label="Sources">
      {citations.map((citation, index) => (
        <button
          key={citation.id}
          type="button"
          class="citation-chip"
          title={citation.snippet || citation.title}
          aria-label={`Source ${index + 1}: ${citation.title}`}
          onClick={() => onClick(citation)}
        >
          <span class="citation-n">{index + 1}</span>
          <span class="citation-title">{citation.title}</span>
        </button>
      ))}
    </div>
  )
}

type ToolPart = { type: string; state?: string; toolName?: string; errorText?: string }
type ApprovalPart = {
  type: string
  state?: string
  toolName?: string
  approval: { id: string }
  input?: unknown
}
function isToolPart(part: unknown): part is ToolPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    typeof (part as { type?: unknown }).type === 'string' &&
    (part as { type: string }).type.startsWith('tool-')
  )
}
function isApprovalPart(part: unknown): part is ApprovalPart {
  return (
    isToolPart(part) &&
    (part as ApprovalPart).state === 'approval-requested' &&
    typeof (part as ApprovalPart).approval?.id === 'string'
  )
}
function ToolChip({ part }: { part: ToolPart }) {
  return (
    <div class="tool-chip" role="status">
      <span>Tool</span>
      <strong>{part.toolName ?? part.type.replace(/^tool-/, '')}</strong>
      <small>
        {part.state === 'approval-requested'
          ? 'Needs approval'
          : part.state === 'output-error'
            ? (part.errorText ?? 'Failed')
            : part.state === 'output-available'
              ? 'Done'
              : 'Running'}
      </small>
    </div>
  )
}
function ApprovalCard({
  part,
  approve,
}: {
  part: ApprovalPart
  approve: (approved: boolean) => void
}) {
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    card.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])
  return (
    <div
      ref={card}
      class="approval-card"
      role="alertdialog"
      aria-modal="true"
      aria-label={`Approve ${part.toolName ?? part.type}`}
      onKeyDown={(event) => trapFocus(event, card.current)}
    >
      <strong>Approval required</strong>
      <p>{part.toolName ?? part.type.replace(/^tool-/, '')} wants to run a tool.</p>
      <details>
        <summary>Show details</summary>
        <pre>{JSON.stringify(part.input ?? {}, null, 2)}</pre>
      </details>
      <div class="approval-actions">
        <button type="button" onClick={() => approve(false)}>
          Deny
        </button>
        <button type="button" onClick={() => approve(true)}>
          Approve
        </button>
      </div>
    </div>
  )
}
function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}
function suggestion(
  action: WidgetController['config']['ui']['messages']['suggestions'][number]['action'],
  controller: WidgetController,
): void {
  try {
    if (action.type === 'send') void controller.send(action.text)
    else if (action.type === 'navigate' && action.path.startsWith('/')) location.assign(action.path)
    else if (action.type === 'link') window.open(action.url, '_blank', 'noopener,noreferrer')
  } catch (error) {
    console.warn('[SiteBot] suggestion action failed', error)
  }
}
function trapFocus(event: KeyboardEvent, root: HTMLElement | null): void {
  if (event.key !== 'Tab' || root === null) return
  const focusable = [
    ...root.querySelectorAll<HTMLElement>('button,summary,[href],[tabindex]:not([tabindex="-1"])'),
  ]
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
