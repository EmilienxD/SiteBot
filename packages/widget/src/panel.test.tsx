import { hostLocale } from './strings.js'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Panel, PanelBoundary } from './panel.js'
import { defaultConfig } from './defaults.js'
import { applyChunk, startMessage } from './ui-stream.js'
import type { WidgetController } from './types.js'

function controller(messages: WidgetController['messages']): WidgetController {
  return {
    options: { endpoint: '/api/chat', publicKey: '' },
    config: structuredClone(defaultConfig),
    get locale() {
      return hostLocale(this.config.ui, this.options.locale)
    },
    setLocale() {},
    messages,
    state: 'idle',
    open() {},
    close() {},
    toggle() {},
    send: vi.fn(async () => {}),
    stop() {},
    reset() {},
    identify() {},
    clearIdentity() {},
    setContext() {},
    setSuggestions() {},
    rehydratePending() {},
    expireStale() {},
    refreshPageContext: async () => null,
    registerTool() {},
    unregisterTool() {},
    approve: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    feedback: vi.fn(async () => {}),
    composerDisabled: false,
    subscribe: () => () => {},
  }
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
  vi.unstubAllGlobals()
})

describe('Panel fidelity', () => {
  it('keeps sparse source numbers and click provenance after wire assembly and history persistence', () => {
    const source = {
      id: 'c27',
      title: 'Trial',
      url: 'https://example.com/en/trial',
      lang: 'en',
      snippet: 'Seven days.',
      score: 0.9,
    }
    const streamed = startMessage(undefined, 'followup')
    for (const chunk of [
      { type: 'text-delta', id: 't', delta: 'Sept jours [27].' },
      { type: 'data-citations', id: 'knowledge-citations', data: { items: [source] } },
    ])
      applyChunk(streamed, chunk)
    const value = controller(JSON.parse(JSON.stringify([streamed.message])))
    value.clickCitation = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(<Panel controller={value} close={() => {}} />, root)
    expect(root.querySelector('.citation-n')?.textContent).toBe('27')
    ;(root.querySelector('.citation-chip') as HTMLButtonElement).click()
    expect(value.clickCitation).toHaveBeenCalledWith(source)
  })
  it('keeps tools and approvals inside their message and attributes only the last assistant in a run', () => {
    const messages = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'First' },
          { type: 'tool-search', state: 'output-available' },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Second' },
          { type: 'tool-write', state: 'approval-requested', approval: { id: 'ap1' } },
        ],
      },
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Thanks' }] },
    ] as WidgetController['messages']
    const root = document.createElement('div')
    document.body.append(root)
    render(<Panel controller={controller(messages)} close={() => {}} />, root)
    const rendered = root.querySelectorAll('.message')
    expect(rendered[0]?.querySelector('.tool-chip')).not.toBeNull()
    expect(rendered[1]?.querySelector('.approval-card')).not.toBeNull()
    expect(rendered[0]?.querySelector('.attribution')).toBeNull()
    expect(rendered[1]?.querySelector('.attribution')).not.toBeNull()
    expect(rendered[1]?.classList.contains('same-role')).toBe(true)
    expect(rendered[2]?.classList.contains('role-change')).toBe(true)
  })

  it('marks the mobile sheet modal and locks body scroll', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
    )
    const root = document.createElement('div')
    document.body.append(root)
    render(<Panel controller={controller([])} close={() => {}} />, root)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.querySelector('.panel')?.getAttribute('aria-modal')).toBe('true')
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('dispatches tool suggestions as hidden turns', () => {
    const value = controller([])
    value.config.ui.messages.suggestions = [
      { label: 'Run', action: { type: 'tool', tool: 'lookup', input: { id: 1 } } },
    ]
    const root = document.createElement('div')
    document.body.append(root)
    render(<Panel controller={value} close={() => {}} />, root)
    ;(root.querySelector('.suggestion') as HTMLButtonElement).click()
    expect(value.send).toHaveBeenCalledWith(expect.stringContaining('lookup'), { hidden: true })
  })

  it('renders handoff, status, inline error and debug usage data', () => {
    const value = controller([])
    Object.defineProperties(value, {
      // The status line is transient: it shows only while a response runs.
      state: { value: 'streaming' },
      statusText: { value: 'Searching documentation…' },
      handoff: {
        value: {
          target: { kind: 'zendesk' },
          ticketUrl: 'https://support.test/ticket/1',
          message: 'A person will reply.',
        },
      },
      inlineError: {
        value: { code: 'provider_error', message: 'Please retry.', retryable: true },
      },
      usage: { value: { inputTokens: 10, outputTokens: 4, costUsd: 0.002 } },
    })
    const root = document.createElement('div')
    render(<Panel controller={value} close={() => {}} />, root)
    expect(root.querySelector('.status')?.textContent).toContain('Searching documentation')
    expect(root.querySelector('.handoff-card')?.textContent).toContain('zendesk')
    // docs/07 §10: the server's error text is never shown, only the fixed copy.
    expect(root.querySelector('.inline-error')?.textContent).toContain('having trouble')
    expect(root.querySelector('.inline-error')?.textContent).not.toContain('Please retry')
    expect(root.querySelector('.usage')?.textContent).toContain('10 in / 4 out')
  })
})

function mount(
  value: WidgetController,
  props: { close?: () => void; offline?: { retry: () => void } } = {},
) {
  const root = document.createElement('div')
  document.body.append(root)
  // `act` flushes effects synchronously; otherwise Preact runs them ~35 ms
  // after paint, which races both real and fake timers.
  act(() => {
    render(
      <Panel controller={value} close={props.close ?? (() => {})} offline={props.offline} />,
      root,
    )
  })
  return root
}
const assistant = (id: string, parts: unknown[]) =>
  ({ id, role: 'assistant', parts }) as WidgetController['messages'][number]
const user = (id: string, text: string, metadata?: unknown) =>
  ({
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata,
  }) as WidgetController['messages'][number]
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Panel behaviour', () => {
  it('rates the last assistant bubble in a run and reports it', () => {
    const value = controller([user('u1', 'Hi'), assistant('a1', [{ type: 'text', text: 'Hello' }])])
    const root = mount(value)
    root.querySelector<HTMLButtonElement>('.feedback button[aria-label="Helpful"]')!.click()
    expect(value.feedback).toHaveBeenCalledWith('a1', 'up')
  })

  it('never renders hidden user turns', () => {
    const root = mount(
      controller([
        user('u1', 'secret tool prompt', { hidden: true }),
        assistant('a1', [{ type: 'text', text: 'Result' }]),
      ]),
    )
    expect(root.textContent).not.toContain('secret tool prompt')
    expect(root.querySelectorAll('.message.user')).toHaveLength(0)
  })

  it('Escape blurs a composer with content, then closes (docs/07 §5)', async () => {
    const close = vi.fn()
    const root = mount(controller([]), { close })
    const textarea = root.querySelector('textarea')!
    textarea.focus()
    textarea.value = 'draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(close).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(textarea)
    root
      .querySelector('.panel')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('ArrowUp on an empty composer recalls the last user message', async () => {
    const root = mount(
      controller([
        user('u1', 'first'),
        assistant('a1', [{ type: 'text', text: 'ok' }]),
        user('u2', 'second'),
      ]),
    )
    const textarea = root.querySelector('textarea')!
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await tick()
    expect(textarea.value).toBe('second')
  })

  it('Enter sends and Shift+Enter does not', async () => {
    const value = controller([])
    const root = mount(value)
    const textarea = root.querySelector('textarea')!
    textarea.value = 'Hello'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    )
    expect(value.send).not.toHaveBeenCalled()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(value.send).toHaveBeenCalledWith('Hello')
  })

  it('adds "Still working…" after 4 s in submitted (docs/07 §7)', async () => {
    vi.useFakeTimers()
    const value = controller([user('u1', 'Hi')])
    Object.defineProperty(value, 'state', { value: 'submitted' })
    const root = mount(value)
    expect(root.querySelector('.typing')).not.toBeNull()
    // Preact runs effects after paint (a 100 ms fallback under fake timers),
    // so the 4 s clock starts slightly after mount.
    await vi.advanceTimersByTimeAsync(3000)
    expect(root.textContent).not.toContain('Still working')
    await vi.advanceTimersByTimeAsync(1200)
    expect(root.textContent).toContain('Still working')
    expect(root.querySelector('.send')?.getAttribute('aria-label')).toBe('Stop response')
    vi.useRealTimers()
  })

  it.each([
    ['rate_limited', 7, 'Retry in 7s', false],
    ['budget_exceeded', undefined, 'usage limit', false],
    ['provider_error', undefined, 'having trouble', true],
    ['run_expired', undefined, 'timed out', true],
  ] as const)('error bubble for %s', (code, retryAfter, copy, retry) => {
    const value = controller([user('u1', 'Hi')])
    Object.defineProperties(value, {
      state: { value: 'error' },
      error: {
        value: {
          code,
          message: 'x',
          retryable: code !== 'budget_exceeded',
        },
      },
      retryAfter: { value: retryAfter },
    })
    const root = mount(value)
    expect(root.querySelector('.error')?.textContent).toContain(copy)
    expect(root.querySelector('.error button') !== null).toBe(retry)
  })

  it('shows a retry state when /config failed at boot (docs/07 §10)', () => {
    const retry = vi.fn()
    const root = mount(controller([]), { offline: { retry } })
    ;(root.querySelector('.offline button') as HTMLButtonElement).click()
    expect(retry).toHaveBeenCalledOnce()
    expect(root.querySelector('textarea')?.disabled).toBe(true)
  })

  it('focuses Deny, not Approve, and shows the server-supplied risk and summary', async () => {
    const value = controller([
      assistant('a1', [
        {
          type: 'data-approval-request',
          data: {
            approvalId: 'ap1',
            toolCallId: 'tc1',
            risk: 'high',
            description: 'Creates a ticket in Zendesk.',
          },
        },
        {
          type: 'tool-create_ticket',
          toolCallId: 'tc1',
          state: 'approval-requested',
          approval: { id: 'ap1' },
          input: { title: 'x' },
        },
      ]),
    ])
    const root = mount(value)
    await tick()
    const card = root.querySelector('.approval-card')!
    expect(card.getAttribute('role')).toBe('alertdialog')
    expect(card.textContent).toContain('Creates a ticket in Zendesk.')
    expect(card.querySelector('.risk.high')).not.toBeNull()
    expect((document.activeElement as HTMLElement).textContent).toBe('Deny')
    ;(card.querySelector('button.primary') as HTMLButtonElement).click()
    expect(value.approve).toHaveBeenCalledWith('ap1', true)
  })

  it('traps focus inside the mobile sheet', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
    )
    const root = mount(controller([]))
    await tick()
    const panel = root.querySelector('.panel') as HTMLElement
    const focusable = [
      ...panel.querySelectorAll<HTMLElement>('button:not([disabled]),textarea:not([disabled])'),
    ]
    focusable.at(-1)!.focus()
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(focusable[0])
  })
})

describe('Panel honours ui.* config keys (review Fix 8)', () => {
  const reasoning = () =>
    controller([
      assistant('a1', [
        { type: 'reasoning', text: 'Let me think.' },
        { type: 'text', text: 'Answer' },
      ]),
    ])

  it('showReasoning: on renders a Thinking disclosure, off hides it', () => {
    const on = reasoning()
    on.config.ui.behaviour.showReasoning = true
    expect(mount(on).querySelector('details.reasoning')?.textContent).toContain('Let me think.')
    expect(mount(reasoning()).querySelector('details.reasoning')).toBeNull()
  })

  it('emptyStateAfterMs: the greeting waits for the delay', async () => {
    vi.useFakeTimers()
    const value = controller([])
    value.config.ui.messages.greeting = 'Welcome!'
    value.config.ui.messages.emptyStateAfterMs = 1500
    const root = mount(value)
    await vi.advanceTimersByTimeAsync(1000)
    expect(root.textContent).not.toContain('Welcome!')
    await vi.advanceTimersByTimeAsync(700)
    expect(root.textContent).toContain('Welcome!')
    vi.useRealTimers()
    const immediate = controller([])
    immediate.config.ui.messages.greeting = 'Welcome!'
    expect(mount(immediate).textContent).toContain('Welcome!')
  })

  it('sound: plays a cue when an assistant message arrives, only when on', async () => {
    const start = vi.fn()
    class FakeAudio {
      currentTime = 0
      destination = {}
      createOscillator() {
        return { frequency: {}, connect: () => ({ connect() {} }), start, stop() {} }
      }
      createGain() {
        return { gain: {} }
      }
    }
    vi.stubGlobal('AudioContext', FakeAudio)
    for (const sound of [true, false]) {
      start.mockClear()
      const value = controller([user('u1', 'Hi')])
      value.config.ui.behaviour.sound = sound
      let listener = () => {}
      value.subscribe = (next) => {
        listener = next
        return () => {}
      }
      const root = mount(value)
      await tick()
      Object.defineProperty(value, 'messages', {
        value: [...value.messages, assistant('a1', [{ type: 'text', text: 'Yo' }])],
      })
      act(() => listener())
      await tick()
      expect(root.textContent).toContain('Yo')
      expect(start).toHaveBeenCalledTimes(sound ? 1 : 0)
    }
  })

  it('allowFileUpload: needs both the key and the server capability', () => {
    const cases: Array<[boolean, boolean, boolean]> = [
      [true, true, true],
      [true, false, false],
      [false, true, false],
    ]
    for (const [key, capability, shown] of cases) {
      const value = controller([])
      value.config.ui.behaviour.allowFileUpload = key
      value.config.capabilities.fileUpload = capability
      expect(mount(value).querySelector('.attach') !== null).toBe(shown)
    }
  })

  it('strings: per-locale overrides replace UI copy, config values included', () => {
    const value = controller([])
    value.options.locale = 'fr-FR'
    value.config.ui.strings = { fr: { placeholder: 'Écrivez…', send: 'Envoyer', close: 'Fermer' } }
    const root = mount(value)
    expect(root.querySelector('textarea')?.placeholder).toBe('Écrivez…')
    expect(root.querySelector('.send')?.getAttribute('aria-label')).toBe('Envoyer')
    expect(root.querySelector('.close')?.getAttribute('aria-label')).toBe('Fermer')
    expect(mount(controller([])).querySelector('textarea')?.placeholder).toBe('Ask a question…')
  })

  it('markdown: off renders assistant text literally', () => {
    const value = controller([assistant('a1', [{ type: 'text', text: '**bold**' }])])
    value.config.ui.behaviour.markdown = false
    const root = mount(value)
    expect(root.querySelector('strong')).toBeNull()
    expect(root.textContent).toContain('**bold**')
  })
})

describe('PanelBoundary', () => {
  it('contains a render error and offers recovery (docs/07 §10)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const Broken = () => {
      throw new Error('boom')
    }
    const root = document.createElement('div')
    document.body.append(root)
    act(() => {
      render(
        <PanelBoundary close={() => {}}>
          <Broken />
        </PanelBoundary>,
        root,
      )
    })
    await tick()
    expect(root.querySelector('.offline')?.textContent).toContain('Something went wrong')
    warn.mockRestore()
  })
})

describe('Panel part ordering', () => {
  it('renders text and tool parts in stream order, one bubble per text run', () => {
    const root = mount(
      controller([
        assistant('a1', [
          { type: 'step-start' },
          { type: 'text', text: 'Let me check. ' },
          { type: 'tool-highlight_section', toolCallId: 't1', state: 'output-available' },
          { type: 'step-start' },
          { type: 'text', text: 'It is ' },
          { type: 'text', text: 'highlighted.' },
        ]),
      ]),
    )
    const order = [
      ...root.querySelectorAll('.message.assistant > .bubble, .message.assistant > .tool-chip'),
    ].map((node) => (node.classList.contains('tool-chip') ? 'chip' : node.textContent?.trim()))
    expect(order).toEqual(['Let me check.', 'chip', 'It is highlighted.'])
  })
})

describe('Tool chip labels', () => {
  const chip = (part: Record<string, unknown>) => {
    const root = mount(
      controller([
        assistant('a1', [{ type: 'tool-fill_wholesale_form', toolCallId: 't1', ...part }]),
      ]),
    )
    const node = root.querySelector('.tool-chip')
    return { text: node?.textContent ?? '', spinning: node?.querySelector('.spinner') !== null }
  }

  it.each([
    [{ state: 'output-available' }, 'Done', false],
    // A denied tool did not run: never "Done", and not left spinning while
    // the server answers the deny.
    [{ state: 'output-denied', approval: { id: 'a', approved: false } }, 'Denied', false],
    [{ state: 'approval-responded', approval: { id: 'a', approved: false } }, 'Denied', false],
    [{ state: 'approval-responded', approval: { id: 'a', approved: true } }, 'Running', true],
    [{ state: 'output-error', errorText: 'expired' }, 'Timed out', false],
    [{ state: 'output-error', errorText: 'skipped' }, 'Skipped', false],
    [{ state: 'output-error', errorText: 'boom' }, 'Failed', false],
  ] as const)('%o → %s', (part, label, spinning) => {
    const rendered = chip(part)
    expect(rendered.text).toContain(label)
    expect(rendered.spinning).toBe(spinning)
  })
})
