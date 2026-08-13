import { render } from 'preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Panel } from './panel.js'
import { defaultConfig } from './defaults.js'
import type { WidgetController } from './types.js'

function controller(messages: WidgetController['messages']): WidgetController {
  return {
    options: { endpoint: '/api/chat', publicKey: '' },
    config: structuredClone(defaultConfig),
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
  document.body.innerHTML = ''
  document.body.style.overflow = ''
  vi.unstubAllGlobals()
})

describe('Panel fidelity', () => {
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
})
