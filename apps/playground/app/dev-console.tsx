'use client'

import { useRef, useState } from 'react'

/**
 * A throwaway chat console. **Deleted in Phase 4**, when `@sitebot/widget`
 * takes over this corner of the page.
 *
 * It exists because Phase 3's demo is otherwise `curl`-only, and "the stream
 * renders token by token in a browser" is worth being able to see. It is
 * deliberately ugly and deliberately dependency-free: nothing here should be
 * mistaken for, or grow into, the real widget. It speaks the wire protocol
 * directly (docs/03 §4) rather than using the AI SDK client, so it also serves
 * as a check that the stream is legible without one.
 */

interface Turn {
  role: 'user' | 'assistant'
  text: string
}

const sessionId = `s_${crypto.randomUUID()}`

export function DevConsole() {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function send(text: string) {
    if (text.trim() === '' || pending) return
    setPending(true)
    setTurns((previous) => [...previous, { role: 'user', text }, { role: 'assistant', text: '' }])

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          messages: [{ id: `m_${Date.now()}`, role: 'user', parts: [{ type: 'text', text }] }],
          pageContext: {
            url: location.href,
            path: location.pathname,
            title: document.title,
            description:
              document.querySelector('meta[name="description"]')?.getAttribute('content') ??
              undefined,
          },
        }),
      })

      if (!response.ok || response.body === null) {
        const body = (await response.json().catch(() => ({}))) as { message?: string }
        appendToLast(setTurns, body.message ?? `Request failed (${response.status}).`)
        return
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value
        // SSE frames are separated by a blank line; keep the trailing partial.
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const payload = frame.replace(/^data: /, '').trim()
          if (payload === '' || payload === '[DONE]') continue
          const chunk = JSON.parse(payload) as { type: string; delta?: string; errorText?: string }
          if (chunk.type === 'text-delta' && chunk.delta !== undefined) {
            appendToLast(setTurns, chunk.delta)
          }
          if (chunk.type === 'error') appendToLast(setTurns, `\n[${chunk.errorText}]`)
        }
      }
    } catch (error) {
      appendToLast(setTurns, `\n[${error instanceof Error ? error.message : 'network error'}]`)
    } finally {
      setPending(false)
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={launcherStyle}>
        Dev console
      </button>
    )
  }

  return (
    <section style={panelStyle} aria-label="SiteBot dev console">
      <header style={panelHeaderStyle}>
        <strong style={{ fontSize: 13 }}>SiteBot dev console</strong>
        <button type="button" onClick={() => setOpen(false)} style={closeStyle} aria-label="Close">
          ×
        </button>
      </header>

      <div style={logStyle}>
        {turns.length === 0 ? (
          <p style={{ color: '#667085', margin: 0 }}>
            Phase 3 demo. Phase 4 replaces this with the real widget.
          </p>
        ) : (
          turns.map((turn, index) => (
            <p key={index} style={{ margin: '0 0 0.6rem' }}>
              <span style={{ color: '#667085' }}>{turn.role === 'user' ? 'you' : 'bot'} </span>
              {turn.text || (pending && index === turns.length - 1 ? '…' : '')}
            </p>
          ))
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          const input = inputRef.current
          if (input === null) return
          void send(input.value)
          input.value = ''
        }}
        style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid #e4e7ec' }}
      >
        <input
          ref={inputRef}
          placeholder="Ask about pricing…"
          style={inputStyle}
          disabled={pending}
        />
        <button type="submit" style={sendStyle} disabled={pending}>
          Send
        </button>
      </form>
    </section>
  )
}

function appendToLast(setTurns: React.Dispatch<React.SetStateAction<Turn[]>>, text: string): void {
  setTurns((previous) => {
    const next = [...previous]
    const last = next[next.length - 1]
    if (last !== undefined) next[next.length - 1] = { ...last, text: last.text + text }
    return next
  })
}

const launcherStyle: React.CSSProperties = {
  position: 'fixed',
  right: 20,
  bottom: 20,
  padding: '10px 16px',
  borderRadius: 999,
  border: '1px solid #d0d5dd',
  background: '#101828',
  color: '#fff',
  font: '500 13px/1 ui-sans-serif, system-ui, sans-serif',
  cursor: 'pointer',
  zIndex: 50,
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  right: 20,
  bottom: 20,
  width: 360,
  maxWidth: 'calc(100vw - 40px)',
  height: 460,
  display: 'flex',
  flexDirection: 'column',
  background: '#fff',
  color: '#101828',
  border: '1px solid #d0d5dd',
  borderRadius: 14,
  boxShadow: '0 20px 50px rgba(16, 24, 40, 0.18)',
  font: '14px/1.55 ui-sans-serif, system-ui, sans-serif',
  overflow: 'hidden',
  zIndex: 50,
}

const panelHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 12px',
  borderBottom: '1px solid #e4e7ec',
}

const logStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: 12,
  whiteSpace: 'pre-wrap',
}

const closeStyle: React.CSSProperties = {
  border: 0,
  background: 'transparent',
  fontSize: 20,
  lineHeight: 1,
  cursor: 'pointer',
  color: '#667085',
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 10px',
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  font: 'inherit',
}

const sendStyle: React.CSSProperties = {
  padding: '8px 14px',
  border: 0,
  borderRadius: 8,
  background: '#1d4ed8',
  color: '#fff',
  font: '500 13px/1 inherit',
  cursor: 'pointer',
}
