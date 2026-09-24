import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig } from './defaults.js'
import { ELEMENT_NAME, SiteChatElement, VERSION } from './element.js'
import { frameStyles } from './iframe-panel.js'
import { styles } from './styles.js'

/**
 * `<site-chat>` end to end in jsdom, with the real panel chunk: the browser API
 * of docs/03 §9, the isolation modes of docs/07 §2, and the degradation rules
 * of docs/07 §10. The server is a stubbed `fetch`.
 */

const roots = new WeakMap<HTMLElement, ShadowRoot>()
const attachShadow = HTMLElement.prototype.attachShadow
HTMLElement.prototype.attachShadow = function (this: HTMLElement, init: ShadowRootInit) {
  const root = attachShadow.call(this, init)
  roots.set(this, root)
  return root
}
const shadow = (element: HTMLElement) => roots.get(element)!

type Json = Record<string, unknown>
const sse = (chunks: Json[]) =>
  new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )

let fetchMock: ReturnType<typeof vi.fn>
let chatResponses: Response[]

function serverConfig(patch: (config: typeof defaultConfig) => void = () => {}) {
  const config = structuredClone(defaultConfig)
  config.ui.behaviour.persistHistory = false
  config.ui.panel.rememberOpenState = false
  patch(config)
  return config
}

function stubServer(config: unknown | Error) {
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/config')) {
      if (config instanceof Error) throw config
      return Response.json(config)
    }
    if (init?.method === 'POST' && !url.endsWith('/feedback'))
      return chatResponses.shift() ?? sse([])
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

async function mount(options: Json = {}): Promise<SiteChatElement> {
  const element = document.createElement(ELEMENT_NAME) as SiteChatElement
  element.configure({ endpoint: '/api/chat', autoOpen: false, ...options })
  document.body.append(element)
  await element.boot()
  await vi.waitFor(() => expect(shadow(element).querySelector('.launcher')).not.toBeNull())
  return element
}

beforeEach(() => {
  document.body.innerHTML = '<main><h1 id="pricing">Pricing</h1><p>Plans start at $10.</p></main>'
  sessionStorage.clear()
  localStorage.clear()
  chatResponses = []
  if (!customElements.get(ELEMENT_NAME)) customElements.define(ELEMENT_NAME, SiteChatElement)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser API (docs/03 §9)', () => {
  it('resolves ready with the config, reports its version, and fires ready', async () => {
    stubServer(serverConfig())
    const onEvent = vi.fn()
    const element = await mount({ onEvent })
    await element.ready
    expect(element.version).toBe(VERSION)
    expect(onEvent).toHaveBeenCalledWith({ type: 'ready', detail: { config: expect.any(Object) } })
  })

  it('forwards controller events to DOM listeners, so SiteBot.on hears them', async () => {
    stubServer(serverConfig())
    chatResponses.push(
      sse([
        { type: 'start', messageId: 'a1' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Plans start at $10.' },
        { type: 'text-end', id: 't' },
        { type: 'finish' },
      ]),
    )
    const element = await mount()
    const heard: unknown[] = []
    window.addEventListener('sitebot:message', (event) => heard.push((event as CustomEvent).detail))
    element.send('How much?')
    await vi.waitFor(() => expect(heard).toHaveLength(2))
    expect(heard[1]).toEqual({ role: 'assistant', text: 'Plans start at $10.', messageId: 'a1' })
    expect(element.isOpen()).toBe(true)
    await vi.waitFor(() =>
      expect(shadow(element).querySelector('.panel')?.textContent).toContain('$10'),
    )
  })

  it('a citation click opens the source safely and fires citation-click (docs/06 §3.9)', async () => {
    stubServer(serverConfig())
    const element = await mount()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const heard: unknown[] = []
    window.addEventListener('sitebot:citation-click', (event) =>
      heard.push((event as CustomEvent).detail),
    )
    element.citationClick({
      id: 'c1',
      title: 'Returns',
      url: 'https://acme.test/returns',
      snippet: '',
      score: 0.9,
    })
    expect(open).toHaveBeenCalledWith('https://acme.test/returns', '_blank', 'noopener,noreferrer')
    expect(heard).toEqual([{ url: 'https://acme.test/returns', title: 'Returns' }])
    open.mockRestore()
  })

  it('destroy() removes the element and never throws', async () => {
    stubServer(serverConfig())
    const element = await mount()
    element.open()
    await element.load()
    expect(() => element.destroy()).not.toThrow()
    expect(document.querySelector(ELEMENT_NAME)).toBeNull()
  })

  it('injects the panel stylesheet only when the chunk loads', async () => {
    stubServer(serverConfig())
    const element = await mount()
    expect(shadow(element).querySelectorAll('style')).toHaveLength(1)
    element.open()
    await element.load()
    expect(shadow(element).querySelectorAll('style')).toHaveLength(2)
  })
})

describe('degradation (docs/07 §10)', () => {
  it('renders the launcher from defaults when /config fails, and the panel retries it', async () => {
    stubServer(new TypeError('offline'))
    const element = await mount()
    element.open()
    await element.load()
    await vi.waitFor(() => expect(shadow(element).querySelector('.offline')).not.toBeNull())
    // The server comes back; Retry refetches config and the panel is usable.
    stubServer(serverConfig((config) => (config.ui.panel.title = 'Back online')))
    ;(shadow(element).querySelector('.offline button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(shadow(element).querySelector('.offline')).toBeNull())
    expect(shadow(element).querySelector('.title')?.textContent).toBe('Back online')
  })
})

describe('resetOnNavigate (docs/02 §11)', () => {
  it('clears the conversation when a page load lands on a different path', async () => {
    stubServer(serverConfig((config) => (config.ui.behaviour.resetOnNavigate = true)))
    sessionStorage.setItem('sitebot:anonymous:path', '/previous-page')
    const history = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'old question' }] }]
    localStorage.setItem('sitebot:anonymous:history', JSON.stringify(history))
    const element = await mount()
    element.open()
    await element.load()
    await vi.waitFor(() => expect(shadow(element).querySelector('.panel')).not.toBeNull())
    expect(shadow(element).querySelector('.panel')?.textContent).not.toContain('old question')
  })

  it('keeps the conversation on the same path', async () => {
    stubServer(
      serverConfig((config) => {
        config.ui.behaviour.resetOnNavigate = true
        config.ui.behaviour.persistHistory = true
      }),
    )
    sessionStorage.setItem('sitebot:anonymous:path', location.pathname)
    const history = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'old question' }] }]
    localStorage.setItem('sitebot:anonymous:history', JSON.stringify(history))
    const element = await mount()
    element.open()
    await element.load()
    await vi.waitFor(() =>
      expect(shadow(element).querySelector('.panel')?.textContent).toContain('old question'),
    )
  })
})

describe('ui.isolation: iframe (docs/07 §2, review Fix 9)', () => {
  it('rewrites :host to :root so the tokens apply inside the frame', () => {
    const css = frameStyles(styles)
    expect(css).not.toContain(':host')
    expect(css).toContain(':root[data-theme=dark]')
    expect(css).toContain(':root:not([data-theme=light])')
  })

  it('mounts the panel inside the frame and runs client tools against the parent page', async () => {
    // jsdom gives an iframe inside a shadow root no browsing context, so the
    // frame's document is supplied here; browsers create it on insertion.
    const documents = new WeakMap<HTMLIFrameElement, Document>()
    const original = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      'contentDocument',
    )!
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
      configurable: true,
      get(this: HTMLIFrameElement) {
        if (!documents.has(this))
          documents.set(this, document.implementation.createHTMLDocument(''))
        return documents.get(this)
      },
    })
    try {
      await iframeScenario()
    } finally {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', original)
    }
  })
})

/** Shared by the iframe test above; runs with a frame document available. */
async function iframeScenario(): Promise<void> {
  stubServer(
    serverConfig((config) => {
      config.ui.isolation = 'iframe'
      config.capabilities.clientTools = ['highlight']
    }),
  )
  chatResponses.push(
    sse([
      { type: 'start', messageId: 'a1' },
      {
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'highlight',
        input: { selector: '#pricing' },
      },
      {
        type: 'data-client-tool-call',
        transient: true,
        data: {
          runId: 'r1',
          toolCallId: 'tc1',
          toolName: 'highlight',
          input: { selector: '#pricing' },
        },
      },
      { type: 'finish' },
    ]),
    sse([{ type: 'start', messageId: 'a1' }, { type: 'finish' }]),
  )
  const target = document.getElementById('pricing')!
  target.scrollIntoView = vi.fn()
  const element = await mount()
  element.open()
  await element.load()
  const frame = await vi.waitFor(() => {
    const found = shadow(element).querySelector<HTMLIFrameElement>('iframe.panel-frame')
    expect(found?.contentDocument?.querySelector('.panel')).toBeTruthy()
    return found!
  })
  // The panel lives in the frame's document, not the shadow root.
  expect(shadow(element).querySelector('.panel')).toBeNull()
  expect(frame.contentDocument?.getElementById('sitebot-style')?.textContent).toContain(':root')

  element.send('Show me pricing')
  // The tool ran in the parent realm, against the host page's DOM…
  await vi.waitFor(() => expect(target.scrollIntoView).toHaveBeenCalled())
  // …and its result went back to the server as a resume.
  await vi.waitFor(() => {
    const resume = fetchMock.mock.calls
      .map(([, init]) => (init as RequestInit | undefined)?.body)
      .filter((body): body is string => typeof body === 'string')
      .map((body) => JSON.parse(body) as Json)
      .find((body) => body.trigger === 'resume')
    expect(resume?.resume).toEqual({
      runId: 'r1',
      clientToolResults: [{ toolCallId: 'tc1', output: { found: true } }],
    })
  })
}
