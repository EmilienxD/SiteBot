import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ELEMENT_NAME, SiteChatElement } from './element.js'
import { defaultConfig } from './defaults.js'

/**
 * The lazy panel chunk, docs/07-widget.md §1: "only the launcher renders until
 * first open, then the chat chunk is dynamically imported. First paint cost is
 * a button."
 *
 * `loaded` counts *evaluations of the module*, so it proves the dynamic import
 * was never requested — not merely that the panel was not rendered. That is the
 * property the bundle budget depends on: a static import anywhere in the
 * launcher's graph would fold this chunk back into the initial payload.
 */
const chunk = vi.hoisted(() => ({
  loaded: 0,
  controllers: 0,
  identified: [] as string[],
  pending: [] as unknown[],
}))

vi.mock('./panel-chunk.js', async () => {
  const { h } = await import('preact')
  chunk.loaded += 1
  return {
    createController: (options: unknown, config: unknown) => {
      chunk.controllers += 1
      return {
        options,
        config,
        messages: [],
        state: 'idle',
        open() {},
        close() {},
        toggle() {},
        send: async () => {},
        stop() {},
        reset() {},
        identify: (jwt: string) => chunk.identified.push(jwt),
        clearIdentity() {},
        setContext() {},
        setSuggestions() {},
        rehydratePending: (pending: unknown) => chunk.pending.push(pending),
        refreshPageContext: async () => null,
        registerTool() {},
        unregisterTool() {},
        approve: async () => {},
        subscribe: () => () => {},
      }
    },
    Panel: () => h('div', { class: 'panel-stub' }, 'panel'),
    IframePanel: () => h('iframe', { class: 'panel-frame-stub' }),
  }
})

/**
 * The shadow root is closed on purpose (docs/07 §2), so the host page — and a
 * test — cannot reach it through `element.shadowRoot`. Capture it at the source
 * instead of weakening the isolation the widget ships with.
 */
const roots = new WeakMap<HTMLElement, ShadowRoot>()
const attachShadow = HTMLElement.prototype.attachShadow
HTMLElement.prototype.attachShadow = function (this: HTMLElement, init: ShadowRootInit) {
  const root = attachShadow.call(this, init)
  roots.set(this, root)
  return root
}

function shadow(element: HTMLElement): ShadowRoot {
  const root = roots.get(element)
  if (!root) throw new Error('the element never attached a shadow root')
  return root
}

async function mountElement(): Promise<SiteChatElement> {
  const element = document.createElement(ELEMENT_NAME) as SiteChatElement
  // Pinned rather than left to `rememberOpenState`: storage.ts mirrors writes
  // into a module-level map that outlives `localStorage.clear()`, so an earlier
  // case's remembered "open" would otherwise auto-open this one.
  element.configure({ endpoint: '/api/chat', autoOpen: false })
  document.body.append(element)
  await element.boot()
  // The launcher renders on a `showAfterMs` timer, zero by default.
  await vi.waitFor(() => expect(shadow(element).querySelector('.launcher')).not.toBeNull())
  return element
}

describe('<site-chat> lazy boot (docs/07 §1)', () => {
  beforeEach(() => {
    // `loaded` is deliberately *not* reset: a module is evaluated once per
    // file, so it is a cumulative count. The first case below asserts it is
    // still zero, which is only meaningful in declaration order.
    chunk.controllers = 0
    chunk.identified = []
    chunk.pending = []
    document.body.innerHTML = ''
    sessionStorage.clear()
    // No config endpoint in jsdom: boot falls back to the packaged defaults.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    if (!customElements.get(ELEMENT_NAME)) customElements.define(ELEMENT_NAME, SiteChatElement)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the launcher without evaluating the panel chunk', async () => {
    const element = await mountElement()
    expect(shadow(element).querySelector('button.launcher')).not.toBeNull()
    expect(shadow(element).querySelector('.panel-stub')).toBeNull()
    expect(chunk.loaded).toBe(0)
    expect(chunk.controllers).toBe(0)
  })

  it('resolves the dynamic import on first open and mounts the panel', async () => {
    const element = await mountElement()
    element.open()
    await element.load()
    expect(chunk.loaded).toBe(1)
    expect(chunk.controllers).toBe(1)
    expect(shadow(element).querySelector('.panel-stub')).not.toBeNull()
    // Still one chunk, one controller: reopening must not refetch or rebuild.
    element.close()
    element.open()
    await element.load()
    expect(chunk.loaded).toBe(1)
    expect(chunk.controllers).toBe(1)
  })

  it('queues controller calls made before the chunk loads', async () => {
    const element = await mountElement()
    element.identify('jwt-before-open')
    expect(chunk.controllers).toBe(0)
    expect(chunk.identified).toEqual([])
    element.open()
    await element.load()
    expect(chunk.identified).toEqual(['jwt-before-open'])
  })

  it('loads the chunk without an explicit open when the panel auto-opens', async () => {
    const element = document.createElement(ELEMENT_NAME) as SiteChatElement
    element.configure({ endpoint: '/api/chat', autoOpen: true })
    document.body.append(element)
    await element.boot()
    await element.load()
    expect(chunk.controllers).toBe(1)
    await vi.waitFor(() => expect(shadow(element).querySelector('.panel-stub')).not.toBeNull())
  })

  it('probes the stored session and rehydrates a pending approval on load', async () => {
    sessionStorage.setItem('sitebot:anonymous:sessionId', 's_pending')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...structuredClone(defaultConfig),
          mode: 'agent',
          pending: {
            runId: 'r1',
            approval: {
              approvalId: 'ap1',
              toolName: 'create_ticket',
              toolCallId: 'tc1',
              risk: 'high',
            },
          },
        }),
      ),
    )
    const element = await mountElement()
    element.open()
    await element.load()
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as URL
    expect(String(request)).toContain('sessionId=s_pending')
    expect(chunk.pending).toEqual([
      expect.objectContaining({
        runId: 'r1',
        approval: expect.objectContaining({ approvalId: 'ap1' }),
      }),
    ])
  })
})
