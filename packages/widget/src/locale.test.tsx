import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createController } from './chat.js'
import { defaultConfig } from './defaults.js'
import { SiteChatElement, ELEMENT_NAME } from './element.js'
import { scriptOptions } from './index.js'
import { Panel } from './panel.js'
import { createStrings, hostLocale, localizedUi } from './strings.js'
import type { WidgetController } from './types.js'

function response(): Response {
  return new Response(
    'data: {"type":"text-start","id":"t"}\n\ndata: {"type":"text-delta","id":"t","delta":"Réponse"}\n\ndata: {"type":"text-end","id":"t"}\n\ndata: [DONE]\n\n',
  )
}
beforeEach(() => {
  document.documentElement.lang = 'fr'
  localStorage.clear()
  sessionStorage.clear()
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
})
afterEach(() => {
  document.body.replaceChildren()
  document.documentElement.removeAttribute('lang')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('host locale behavior', () => {
  it('fixes html lang=fr with an English browser, including the reported send override', () => {
    const ui = structuredClone(defaultConfig.ui)
    ui.strings = { fr: { send: 'Envoyer' } }
    expect(hostLocale(ui)).toBe('fr')
    expect(createStrings(ui)('send')).toBe('Envoyer')
    expect(createStrings(ui)('placeholder')).toBe('Posez une question…')
    expect(createStrings(ui)('launcherAriaLabel')).toBe('Ouvrir l’assistant de discussion')
    expect(hostLocale(ui, 'en-US')).toBe('en')
  })
  it('overlays translated greetings, suggestions, title, launcher and footer without mutating base copy', () => {
    const ui = structuredClone(defaultConfig.ui)
    ui.messages.greeting = 'Welcome to Example'
    ui.translations = {
      fr: {
        messages: {
          greeting: 'Bienvenue chez Example',
          suggestions: [{ label: 'Aide', action: { type: 'send', text: 'Aidez-moi' } }],
        },
        launcher: { label: 'Aide' },
        panel: { title: 'Example vous aide' },
        footer: { text: 'Confidentialité' },
      },
    }
    expect(createStrings(ui, 'fr')('greeting')).toBe('Bienvenue chez Example')
    expect(localizedUi(ui, 'fr').messages.suggestions[0]?.action).toEqual({
      type: 'send',
      text: 'Aidez-moi',
    })
    expect(localizedUi(ui, 'fr').panel.title).toBe('Example vous aide')
    expect(localizedUi(ui, 'fr').launcher.label).toBe('Aide')
    expect(localizedUi(ui, 'fr').footer?.text).toBe('Confidentialité')
    expect(ui.messages.greeting).toBe('Welcome to Example')
    expect(createStrings(ui, 'en')('greeting')).toBe('Welcome to Example')
  })
  it('updates an existing conversation, DOM copy and every request, including retries, without changing session or history', async () => {
    const fetcher = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetcher)
    const config = structuredClone(defaultConfig)
    const mount = document.createElement('div')
    document.body.append(mount)
    const paint = () => render(<Panel controller={controller} close={() => {}} />, mount)
    const controller: WidgetController = createController(
      { endpoint: '/api/chat', publicKey: 'locale-conversation' },
      config,
      paint,
    )
    act(paint)
    expect(mount.querySelector('.send')?.getAttribute('aria-label')).toBe('Envoyer le message')
    await act(async () => {
      await controller.send('Bonjour')
    })
    const history = [...controller.messages]
    document.documentElement.lang = 'en'
    act(paint)
    expect(mount.querySelector('.send')?.getAttribute('aria-label')).toBe('Send message')
    expect(controller.messages).toEqual(history)
    await act(async () => {
      await controller.send('Second message')
    })
    act(() => controller.setLocale('fr-CA'))
    expect(mount.querySelector('textarea')?.placeholder).toBe('Posez une question…')
    await act(async () => {
      await controller.retry()
    })
    const requests = fetcher.mock.calls.map((args) => args as unknown as [string, RequestInit])
    const bodies = requests.map(([, request]) => JSON.parse(String(request.body)))
    expect(bodies.map((body) => body.locale)).toEqual(['fr', 'en', 'fr'])
    expect(bodies.map((body) => body.pageContext.locale)).toEqual(['fr', 'en', 'fr'])
    expect(new Set(bodies.map((body) => body.sessionId)).size).toBe(1)
    expect(
      bodies[1].messages.some((message: { parts: unknown[] }) =>
        JSON.stringify(message.parts).includes('Bonjour'),
      ),
    ).toBe(true)
    expect(
      requests.map(([, request]) => (request.headers as Record<string, string>)['accept-language']),
    ).toEqual(['fr', 'en', 'fr'])
    render(null, mount)
  })
  it('observes host document changes and custom-element overrides while the panel is open', async () => {
    const roots = new Map<HTMLElement, ShadowRoot>()
    const attach = HTMLElement.prototype.attachShadow
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (
      this: HTMLElement,
      init,
    ) {
      const root = attach.call(this, init)
      roots.set(this, root)
      return root
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(structuredClone(defaultConfig))),
    )
    if (!customElements.get(ELEMENT_NAME)) customElements.define(ELEMENT_NAME, SiteChatElement)
    const element = document.createElement(ELEMENT_NAME) as SiteChatElement
    element.configure({ autoOpen: false })
    document.body.append(element)
    await element.boot()
    await act(async () => {
      element.open()
      await element.load()
    })
    const root = roots.get(element)!
    await vi.waitFor(() =>
      expect(root.querySelector('.send')?.getAttribute('aria-label')).toBe('Envoyer le message'),
    )
    document.documentElement.lang = 'en'
    await vi.waitFor(() =>
      expect(root.querySelector('.launcher')?.getAttribute('aria-label')).toBe(
        'Open chat assistant',
      ),
    )
    await vi.waitFor(() =>
      expect(root.querySelector('.send')?.getAttribute('aria-label')).toBe('Send message'),
    )
    element.setAttribute('data-locale', 'fr-CA')
    await vi.waitFor(() =>
      expect(root.querySelector('.send')?.getAttribute('aria-label')).toBe('Envoyer le message'),
    )
    act(() => element.configure({ locale: 'en' }))
    expect(root.querySelector('.send')?.getAttribute('aria-label')).toBe('Send message')
    act(() => element.setLocale('auto'))
    expect(root.querySelector('.send')?.getAttribute('aria-label')).toBe('Send message')
    element.destroy()
  })
  it('accepts the script data-locale option', () => {
    const script = document.createElement('script')
    script.dataset.locale = 'fr-CA'
    expect(scriptOptions(script).locale).toBe('fr-CA')
  })
})

it('relabels a validation error in an existing conversation using its safe key and values', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          code: 'invalid_request',
          message: 'Ce message est trop long.',
          messageKey: 'messageTooLong',
          values: { maxChars: 12 },
        },
        { status: 400 },
      ),
    ),
  )
  const mount = document.createElement('div')
  document.body.append(mount)
  const paint = () => render(<Panel controller={controller} close={() => {}} />, mount)
  const controller = createController(
    { endpoint: '/api/chat', publicKey: 'locale-errors' },
    structuredClone(defaultConfig),
    paint,
  )
  await act(async () => {
    await controller.send('An overlong message')
  })
  expect(mount.querySelector('.error')?.textContent).toContain('12 caractères')
  const history = [...controller.messages]
  document.documentElement.lang = 'en'
  act(() => controller.setLocale('auto'))
  expect(mount.querySelector('.error')?.textContent).toContain('12 characters')
  expect(controller.messages).toEqual(history)
  render(null, mount)
})

it('renders a synthetic third locale from configuration alone', () => {
  const config = structuredClone(defaultConfig)
  config.ui.supportedLocales.push('de')
  config.ui.strings.de = {
    send: 'Senden',
    placeholder: 'Frage stellen…',
    assistantName: 'Assistent',
  }
  const controller = createController(
    { endpoint: '/api/chat', publicKey: 'third-locale', locale: 'de-CH' },
    config,
    () => {},
  )
  const mount = document.createElement('div')
  document.body.append(mount)
  act(() => render(<Panel controller={controller} close={() => {}} />, mount))
  expect(controller.locale).toBe('de')
  expect(mount.querySelector('.send')?.getAttribute('aria-label')).toBe('Senden')
  expect(mount.querySelector('textarea')?.placeholder).toBe('Frage stellen…')
  expect(mount.querySelector('.title')?.textContent).toBe('Assistent')
  render(null, mount)
})
