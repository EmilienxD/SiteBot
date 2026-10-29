import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createController, normalizeError, resumePayload, HttpError } from './chat.js'
import { defaultConfig } from './defaults.js'
import type { SiteBotEvent, UIMessage, WidgetController } from './types.js'

/**
 * The chat controller against a stubbed `fetch` — docs/07-widget.md §7
 * (state machine) and §10 (failure and degradation), docs/03 §5 (resume).
 * Every response below is a real SSE body in the shape the server emits.
 */

type Json = Record<string, unknown>

function sse(chunks: Json[], init: ResponseInit = {}): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  })
}

function answer(text: string, messageId = 'a_srv'): Json[] {
  return [
    { type: 'start', messageId },
    { type: 'start-step' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish-step' },
    { type: 'finish' },
  ]
}

function errorResponse(status: number, body: Json, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** A body that streams `chunks`, then dies the way a dropped socket does. */
function droppedMidStream(chunks: Json[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        controller.error(new TypeError('network error'))
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

let fetchMock: ReturnType<typeof vi.fn>
let events: SiteBotEvent[]

function setup(configure: (config: typeof defaultConfig) => void = () => {}): WidgetController {
  const config = structuredClone(defaultConfig)
  config.ui.behaviour.persistHistory = false
  configure(config)
  return createController(
    { endpoint: '/api/chat', publicKey: 'pk_test', onEvent: (event) => events.push(event) },
    config,
    () => {},
  )
}

function body(call: number): Json {
  return JSON.parse(String((fetchMock.mock.calls[call]?.[1] as RequestInit).body)) as Json
}

beforeEach(() => {
  events = []
  sessionStorage.clear()
  localStorage.clear()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('page context hashing (docs/03 §9–10)', () => {
  it('sends the extract once, then only its hash — and again after an SPA route change', async () => {
    document.body.innerHTML = '<main><p>First view of the app.</p></main>'
    const controller = setup()
    fetchMock.mockImplementation(async () => sse(answer('ok')))
    const context = (call: number) => body(call).pageContext as Json

    await controller.send('one')
    expect(context(0).extract).toContain('First view')
    await controller.send('two')
    expect(context(1).extract).toBeUndefined()
    expect(context(1).extractHash).toBe(context(0).extractHash)

    // The route changes client-side; the app calls refreshPageContext().
    document.body.innerHTML = '<main><p>Second view, pricing.</p></main>'
    await controller.refreshPageContext()
    await controller.send('three')
    expect(context(2).extract).toContain('Second view')
  })

  it('resends the extract when the request that carried it failed', async () => {
    document.body.innerHTML = '<main><p>Only view.</p></main>'
    const controller = setup()
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    await controller.send('one')
    fetchMock.mockResolvedValueOnce(sse(answer('ok')))
    await controller.send('two')
    const last = body(fetchMock.mock.calls.length - 1).pageContext as Json
    expect(last.extract).toContain('Only view.')
  })
})

describe('identity (docs/07 §9)', () => {
  it('keeps the identify() token in memory, never in local or session storage', async () => {
    fetchMock.mockResolvedValueOnce(sse(answer('Hello!')))
    const controller = setup()
    controller.identify('jwt-secret-token')
    await controller.send('Hi there')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ auth: 'jwt-secret-token' })
    const stored = [localStorage, sessionStorage]
      .flatMap((storage) =>
        Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!)),
      )
      .join('\n')
    expect(stored).not.toContain('jwt-secret-token')
  })
})

describe('send → stream → idle', () => {
  it('posts the documented request and renders the streamed answer', async () => {
    fetchMock.mockResolvedValueOnce(sse(answer('Hello!')))
    const controller = setup()
    controller.identify('jwt-1')
    controller.setContext({ plan: 'pro' })
    const states: string[] = []
    controller.subscribe(() => states.push(controller.state))
    await controller.send('Hi there')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/chat')
    expect((init.headers as Record<string, string>)['x-sitebot-key']).toBe('pk_test')
    const sent = body(0)
    expect(sent).toMatchObject({ trigger: 'submit-message', auth: 'jwt-1' })
    expect(typeof sent.sessionId).toBe('string')
    expect(sent.messages).toEqual([
      expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: 'Hi there' }] }),
    ])
    expect((sent.pageContext as Json).custom).toEqual({ plan: 'pro' })

    expect(states).toContain('submitted')
    expect(states).toContain('streaming')
    expect(controller.state).toBe('idle')
    expect(controller.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(controller.messages[1]?.id).toBe('a_srv')
    expect(events.filter((event) => event.type === 'message').map((event) => event.detail)).toEqual(
      [
        expect.objectContaining({ role: 'user', text: 'Hi there' }),
        { role: 'assistant', text: 'Hello!', messageId: 'a_srv' },
      ],
    )
  })

  it('keeps the reply to a hidden turn and marks only the user turn hidden', async () => {
    fetchMock.mockResolvedValueOnce(sse(answer('Done.')))
    const controller = setup()
    await controller.send('Use the lookup tool', { hidden: true })
    expect(controller.messages).toHaveLength(2)
    expect(controller.messages[0]?.metadata).toEqual({ hidden: true })
    expect(controller.messages[1]?.role).toBe('assistant')
  })

  it('stop() aborts the request and keeps what streamed', async () => {
    const encoder = new TextEncoder()
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'text-start', id: 't' })}\n\n`),
          )
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'text-delta', id: 't', delta: 'Partial' })}\n\n`,
            ),
          )
          init.signal?.addEventListener('abort', () =>
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        },
      })
      return new Response(stream, { status: 200 })
    })
    const controller = setup()
    const sending = controller.send('Tell me a long story')
    await vi.waitFor(() => expect(controller.state).toBe('streaming'))
    controller.stop()
    await sending
    expect(controller.state).toBe('idle')
    expect(controller.error).toBeUndefined()
    expect(controller.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Partial' }),
    )
  })

  it('a new send during a stream aborts the running one first (docs/07 §7)', async () => {
    let aborted = false
    fetchMock.mockImplementationOnce(
      async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'))
              init.signal?.addEventListener('abort', () => {
                aborted = true
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
              })
            },
          }),
        ),
    )
    fetchMock.mockResolvedValueOnce(sse(answer('Second')))
    const controller = setup()
    const first = controller.send('First')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await controller.send('Second question')
    await first
    expect(aborted).toBe(true)
    expect(controller.state).toBe('idle')
    expect(controller.messages.filter((message) => message.role === 'user')).toHaveLength(2)
  })
})

describe('failure and degradation (docs/07 §10)', () => {
  it('429: shows a Retry-After countdown and disables the composer until it elapses', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    fetchMock.mockResolvedValueOnce(
      errorResponse(429, { code: 'rate_limited', message: 'Slow down.' }, { 'retry-after': '3' }),
    )
    const controller = setup()
    await controller.send('Hi')
    expect(controller.state).toBe('error')
    expect(controller.error?.code).toBe('rate_limited')
    expect(controller.retryAfter).toBe(3)
    expect(controller.composerDisabled).toBe(true)
    await controller.send('Blocked while counting down')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(controller.retryAfter).toBe(1)
    expect(controller.composerDisabled).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(controller.retryAfter).toBe(0)
    expect(controller.composerDisabled).toBe(false)
    expect(events).toContainEqual({
      type: 'error',
      detail: expect.objectContaining({ code: 'rate_limited' }),
    })
  })

  it('budget_exceeded: friendly message, composer disabled, no retry', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(402, { code: 'budget_exceeded', message: 'x' }))
    const controller = setup()
    await controller.send('Hi')
    expect(controller.error).toMatchObject({ code: 'budget_exceeded', retryable: false })
    expect(controller.composerDisabled).toBe(true)
  })

  it('provider down: generic copy, never the upstream text, and Retry regenerates', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(502, {
        code: 'provider_error',
        message: 'Anthropic 529 overloaded_error at edge-7',
      }),
    )
    fetchMock.mockResolvedValueOnce(sse(answer('Back now.')))
    const controller = setup()
    await controller.send('Hi')
    expect(controller.error).toMatchObject({ code: 'provider_error', retryable: true })
    expect(controller.error?.message).not.toContain('Anthropic')
    await controller.retry()
    expect(body(1).trigger).toBe('regenerate')
    expect(controller.state).toBe('idle')
    expect(controller.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('network drop mid-stream: one automatic retry, which can succeed', async () => {
    fetchMock.mockResolvedValueOnce(droppedMidStream(answer('Half').slice(0, 4)))
    fetchMock.mockResolvedValueOnce(sse(answer('Whole answer.')))
    const controller = setup()
    await controller.send('Hi')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(body(1).trigger).toBe('regenerate')
    // The partial answer was dropped, not duplicated.
    expect(controller.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(controller.messages[1])).toContain('Whole answer.')
    expect(controller.state).toBe('idle')
  })

  it('network drop twice: gives up after the single retry with a manual Retry', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const controller = setup()
    await controller.send('Hi')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(controller.state).toBe('error')
    expect(controller.error).toMatchObject({ code: 'network', retryable: true })
  })

  it('an in-stream data-error renders inline and keeps the conversation usable', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        { type: 'start' },
        { type: 'data-error', data: { code: 'provider_error', message: 'x', retryable: true } },
        { type: 'finish' },
      ]),
    )
    const controller = setup()
    await controller.send('Hi')
    expect(controller.inlineError).toMatchObject({ retryable: true })
    expect(controller.state).toBe('idle')
  })
})

describe('suspend / resume (docs/03 §5)', () => {
  const approvalStream = (runId: string) => [
    { type: 'start', messageId: 'a1' },
    { type: 'start-step' },
    {
      type: 'tool-input-available',
      toolCallId: 'tc1',
      toolName: 'create_ticket',
      input: { title: 'Help' },
    },
    { type: 'tool-approval-request', approvalId: 'ap1', toolCallId: 'tc1' },
    {
      type: 'data-approval-request',
      data: {
        approvalId: 'ap1',
        runId,
        toolCallId: 'tc1',
        toolName: 'create_ticket',
        risk: 'high',
      },
    },
    { type: 'finish-step' },
    { type: 'finish' },
  ]

  it('awaits approval, then resumes the run with the decision', async () => {
    fetchMock.mockResolvedValueOnce(sse(approvalStream('r_1')))
    fetchMock.mockResolvedValueOnce(
      sse([
        { type: 'start', messageId: 'a1' },
        { type: 'start-step' },
        { type: 'tool-output-available', toolCallId: 'tc1', output: { id: 'T-1' } },
        { type: 'text-start', id: 'x' },
        { type: 'text-delta', id: 'x', delta: 'Created T-1.' },
        { type: 'text-end', id: 'x' },
        { type: 'finish' },
      ]),
    )
    const controller = setup()
    await controller.send('Open a ticket')
    expect(controller.state).toBe('awaiting-approval')
    await controller.approve('ap1', true)
    const resumed = body(1)
    expect(resumed.trigger).toBe('resume')
    expect(resumed.resume).toEqual({
      runId: 'r_1',
      approvals: [{ approvalId: 'ap1', decision: 'approve' }],
    })
    expect(controller.state).toBe('idle')
    // One assistant turn, continued rather than duplicated.
    expect(controller.messages.map((message) => message.id)).toEqual([expect.any(String), 'a1'])
    expect(events).toContainEqual({
      type: 'approval',
      detail: { approvalId: 'ap1', toolName: 'create_ticket', decision: 'approve' },
    })
  })

  it('a deny resumes too, with decision deny', async () => {
    fetchMock.mockResolvedValueOnce(sse(approvalStream('r_2')))
    fetchMock.mockResolvedValueOnce(sse(answer('Okay, I will not.', 'a1')))
    const controller = setup()
    await controller.send('Open a ticket')
    await controller.approve('ap1', false)
    expect((body(1).resume as Json).approvals).toEqual([{ approvalId: 'ap1', decision: 'deny' }])
  })

  const toolPart = (controller: WidgetController) =>
    controller.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool-create_ticket')

  it('410 on resume: the card and its chip settle as expired, and Retry starts a fresh turn', async () => {
    fetchMock.mockResolvedValueOnce(sse(approvalStream('r_x')))
    fetchMock.mockResolvedValueOnce(errorResponse(410, { code: 'invalid_request' }))
    fetchMock.mockResolvedValueOnce(
      sse(answer('That request timed out — shall I try again?', 'a1')),
    )
    const controller = setup()
    await controller.send('Open a ticket')
    await controller.approve('ap1', true)

    expect(controller.error?.code).toBe('run_expired')
    // Not left on a spinning "Running", and no live Approve/Deny.
    expect(toolPart(controller)).toMatchObject({ state: 'output-error', errorText: 'expired' })
    expect(toolPart(controller)?.approval).toBeUndefined()
    expect(controller.state).toBe('error')

    await controller.retry()
    // A fresh turn, not another resume of the dead run.
    expect(body(2).trigger).toBe('regenerate')
    expect(body(2).resume).toBeUndefined()
    expect(controller.state).toBe('idle')
    expect(controller.messages.at(-1)?.parts.some((part) => part.type === 'text')).toBe(true)
  })

  it('a new message moves past a pending approval and settles it as skipped', async () => {
    fetchMock.mockResolvedValueOnce(sse(approvalStream('r_s')))
    fetchMock.mockResolvedValueOnce(sse(answer('Sure, here are the hours.', 'a2')))
    const controller = setup()
    await controller.send('Open a ticket')
    await controller.send('Never mind — opening hours?')
    expect(toolPart(controller)).toMatchObject({ state: 'output-error', errorText: 'skipped' })
    expect(body(1).trigger).toBe('submit-message')
    expect(body(1).resume).toBeUndefined()
  })

  it('expireStale(): a cached card the session probe no longer reports is settled', async () => {
    fetchMock.mockResolvedValueOnce(sse(approvalStream('r_old')))
    const controller = setup()
    await controller.send('Open a ticket')
    expect(controller.state).toBe('awaiting-approval')
    controller.expireStale()
    expect(controller.state).toBe('idle')
    expect(toolPart(controller)).toMatchObject({ state: 'output-error', errorText: 'expired' })
  })

  it('rehydrates a pending approval from the /config probe', async () => {
    fetchMock.mockResolvedValueOnce(sse(answer('Created.', 'pending-r_9')))
    const controller = setup()
    controller.rehydratePending({
      runId: 'r_9',
      approval: { approvalId: 'ap9', toolName: 'create_ticket', toolCallId: 'tc9', risk: 'medium' },
    })
    expect(controller.state).toBe('awaiting-approval')
    await controller.approve('ap9', true)
    expect(body(0).resume).toEqual({
      runId: 'r_9',
      approvals: [{ approvalId: 'ap9', decision: 'approve' }],
    })
  })

  it('executes an allowed client tool in the page and posts the result back', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        { type: 'start', messageId: 'a1' },
        { type: 'start-step' },
        { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'read_cart', input: {} },
        { type: 'finish-step' },
        {
          type: 'data-client-tool-call',
          transient: true,
          data: { runId: 'r_c', toolCallId: 'tc1', toolName: 'read_cart', input: {} },
        },
        { type: 'finish' },
      ]),
    )
    fetchMock.mockResolvedValueOnce(sse(answer('You have 2 items.', 'a1')))
    const controller = setup((config) => {
      config.capabilities.clientTools = ['read_cart']
    })
    let release!: () => void
    controller.registerTool(
      'read_cart',
      () => new Promise((resolve) => (release = () => resolve({ items: 2 }))),
    )
    await controller.send('What is in my cart?')
    await vi.waitFor(() => expect(controller.state).toBe('executing-client-tool'))
    release()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(body(1).resume).toEqual({
      runId: 'r_c',
      clientToolResults: [{ toolCallId: 'tc1', output: { items: 2 } }],
    })
    await vi.waitFor(() => expect(controller.state).toBe('idle'))
    expect(
      events.filter((event) => event.type === 'tool').map((event) => (event.detail as Json).phase),
    ).toEqual(['call', 'result'])
  })

  it('posts an approved client tool result after the approval-only handoff', async () => {
    fetchMock.mockResolvedValueOnce(sse(approvalStream('r_approved')))
    // The real server returns only the handoff: it does not echo a new
    // tool-input-available chunk or call the model until the result arrives.
    fetchMock.mockResolvedValueOnce(
      sse([
        { type: 'start', messageId: 'a1' },
        {
          type: 'data-client-tool-call',
          transient: true,
          data: {
            runId: 'r_approved',
            toolCallId: 'tc1',
            toolName: 'create_ticket',
            input: { title: 'Help' },
          },
        },
        { type: 'finish' },
      ]),
    )
    fetchMock.mockResolvedValueOnce(sse(answer('Created T-1.', 'a1')))
    const controller = setup((config) => {
      config.capabilities.clientTools = ['create_ticket']
    })
    const tool = vi.fn(() => ({ id: 'T-1' }))
    controller.registerTool('create_ticket', tool)
    await controller.send('Open a ticket')
    await controller.approve('ap1', true)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(tool).toHaveBeenCalledExactlyOnceWith({ title: 'Help' })
    expect(body(2).resume).toEqual({
      runId: 'r_approved',
      clientToolResults: [{ toolCallId: 'tc1', output: { id: 'T-1' } }],
    })
    await vi.waitFor(() => expect(controller.state).toBe('idle'))
    expect(toolPart(controller)?.state).toBe('output-available')
    expect(controller.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Created T-1.' }),
    )
  })

  it('refuses a client tool the server did not allowlist', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        { type: 'start', messageId: 'a1' },
        { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'steal_cookies', input: {} },
        {
          type: 'data-client-tool-call',
          transient: true,
          data: { runId: 'r_x', toolCallId: 'tc1', toolName: 'steal_cookies', input: {} },
        },
        { type: 'finish' },
      ]),
    )
    fetchMock.mockResolvedValueOnce(sse(answer('Sorry.', 'a1')))
    const ran = vi.fn()
    const controller = setup()
    controller.registerTool('steal_cookies', ran)
    await controller.send('go')
    await vi.waitFor(() =>
      expect(events.some((event) => (event.detail as Json)?.phase === 'error')).toBe(true),
    )
    expect(ran).not.toHaveBeenCalled()
  })
})

describe('navigation waits for the run to settle', () => {
  it('a client-tool navigate leaves the page only after the result is posted back', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...location, assign, pathname: '/', href: 'https://acme.test/' })
    fetchMock.mockResolvedValueOnce(
      sse([
        { type: 'start', messageId: 'a1' },
        {
          type: 'tool-input-available',
          toolCallId: 'tc1',
          toolName: 'go_to',
          input: { path: '/pricing' },
        },
        {
          type: 'data-client-tool-call',
          transient: true,
          data: { runId: 'r_n', toolCallId: 'tc1', toolName: 'go_to', input: { path: '/pricing' } },
        },
        { type: 'finish' },
      ]),
    )
    let resumeSeenBeforeNavigation = false
    fetchMock.mockImplementationOnce(async () => {
      resumeSeenBeforeNavigation = assign.mock.calls.length === 0
      return sse(answer('Here is pricing.', 'a1'))
    })
    const controller = setup((config) => {
      config.capabilities.clientTools = ['go_to']
      config.capabilities.clientToolIds = { go_to: 'navigate' }
      config.capabilities.routes = ['/pricing']
    })
    await controller.send('Show me pricing')
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/pricing'))
    expect(resumeSeenBeforeNavigation).toBe(true)
    expect(body(1).resume).toMatchObject({
      clientToolResults: [{ toolCallId: 'tc1', output: { navigated: true, path: '/pricing' } }],
    })
  })
})

describe('data parts', () => {
  it('navigates only to server-declared routes', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...location, assign, pathname: '/', href: 'https://acme.test/' })
    fetchMock.mockResolvedValueOnce(
      sse([
        { type: 'start' },
        { type: 'data-navigate', data: { path: '/pricing', newTab: false } },
        { type: 'data-navigate', data: { path: '/admin', newTab: false } },
        { type: 'finish' },
      ]),
    )
    const controller = setup((config) => {
      config.capabilities.routes = ['/pricing']
    })
    await controller.send('Take me to pricing')
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/pricing')
    expect(events).toContainEqual({
      type: 'error',
      detail: expect.objectContaining({ code: 'route_not_allowed' }),
    })
  })

  it('handoff, status, usage and suggestions update the controller', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        { type: 'start' },
        { type: 'data-status', transient: true, data: { text: 'Searching…' } },
        {
          type: 'data-suggestions',
          data: { items: [{ label: 'More', action: { type: 'send', text: 'More' } }] },
        },
        {
          type: 'data-handoff',
          data: { target: { kind: 'email' }, message: 'We will email you.' },
        },
        { type: 'data-usage', data: { inputTokens: 1, outputTokens: 2, costUsd: 0 } },
        { type: 'finish' },
      ]),
    )
    const controller = setup()
    const seen: Array<string | undefined> = []
    controller.subscribe(() => seen.push(controller.statusText))
    await controller.send('Help')
    expect(seen).toContain('Searching…')
    expect(controller.statusText).toBeUndefined()
    expect(controller.suggestions).toEqual([
      { label: 'More', action: { type: 'send', text: 'More' } },
    ])
    expect(controller.handoff).toMatchObject({ message: 'We will email you.' })
    expect(controller.usage).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: 0 })
    expect(events).toContainEqual({ type: 'handoff', detail: { target: { kind: 'email' } } })
    // data-status is transient: never part of the stored message.
    expect(JSON.stringify(controller.messages)).not.toContain('data-status')
  })
})

describe('session and persistence (docs/07 §9)', () => {
  it('reset() clears the conversation and starts a new session', async () => {
    fetchMock.mockResolvedValue(sse(answer('Hi')))
    const controller = setup()
    await controller.send('One')
    const before = body(0).sessionId
    controller.reset()
    expect(controller.messages).toEqual([])
    await controller.send('Two')
    expect(body(1).sessionId).not.toBe(before)
  })

  it('persistHistory restores the transcript into a new controller', async () => {
    fetchMock.mockResolvedValue(sse(answer('Remembered')))
    const make = () =>
      createController(
        { endpoint: '/api/chat', publicKey: 'pk_hist' },
        structuredClone(defaultConfig),
        () => {},
      )
    await make().send('Hello')
    expect(make().messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('feedback posts to /feedback and emits the event', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const controller = setup()
    await controller.feedback('a_srv', 'up')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/chat/feedback')
    expect(body(0)).toMatchObject({ messageId: 'a_srv', rating: 'up' })
    expect(events).toContainEqual({
      type: 'feedback',
      detail: { messageId: 'a_srv', rating: 'up' },
    })
  })

  it.each(['tab', 'browser'] as const)(
    'stores history with its %s-scoped session',
    async (scope) => {
      fetchMock.mockResolvedValue(sse(answer('Remembered')))
      const make = () => {
        const config = structuredClone(defaultConfig)
        config.ui.behaviour.sessionScope = scope
        return createController({ endpoint: '/api/chat', publicKey: 'pk_scope' }, config, () => {})
      }
      await make().send('Hello')
      const firstSession = body(0).sessionId
      const storage = scope === 'tab' ? sessionStorage : localStorage
      expect(storage.getItem('sitebot:pk_scope:history')).toContain('Remembered')
      // A new tab shares localStorage, but starts with empty sessionStorage.
      sessionStorage.clear()
      const second = make()
      expect(second.messages.length > 0).toBe(scope === 'browser')
      await second.send('Again')
      expect(body(1).sessionId === firstSession).toBe(scope === 'browser')
    },
  )
})

describe('resumePayload', () => {
  const assistant = (parts: Json[]): UIMessage => ({
    id: 'a',
    role: 'assistant',
    parts: parts as never,
  })

  it('uses the newest run when Retry continues an assistant message after expiry', () => {
    const message = assistant([
      { type: 'data-approval-request', data: { runId: 'r_expired' } },
      { type: 'step-start' },
      { type: 'data-approval-request', data: { runId: 'r_fresh' } },
      {
        type: 'tool-fill_form',
        toolCallId: 'tc_new',
        state: 'approval-responded',
        approval: { id: 'ap_new', approved: true },
      },
    ])
    expect(resumePayload([message], 'r_expired', ['fill_form'])).toEqual({
      runId: 'r_fresh',
      approvals: [{ approvalId: 'ap_new', decision: 'approve' }],
    })
  })

  it('reads approvals and client-tool results from the last step only', () => {
    const message = assistant([
      { type: 'tool-read_cart', toolCallId: 'old', state: 'output-available', output: 1 },
      { type: 'step-start' },
      {
        type: 'tool-create_ticket',
        toolCallId: 'tc1',
        state: 'approval-responded',
        approval: { id: 'ap1', approved: true },
      },
      { type: 'tool-read_cart', toolCallId: 'tc2', state: 'output-available', output: { n: 2 } },
      {
        type: 'tool-get_time',
        toolCallId: 'tc3',
        state: 'output-available',
        output: 'server tool',
      },
    ])
    expect(resumePayload([message], 'r_known', ['read_cart'])).toEqual({
      runId: 'r_known',
      approvals: [{ approvalId: 'ap1', decision: 'approve' }],
      clientToolResults: [{ toolCallId: 'tc2', output: { n: 2 } }],
    })
  })

  it("prefers the message's own run id", () => {
    const message = assistant([
      { type: 'data-approval-request', data: { runId: 'r_msg' } },
      {
        type: 'tool-x',
        toolCallId: 't',
        state: 'approval-responded',
        approval: { id: 'a', approved: false },
      },
    ])
    expect(resumePayload([message], 'r_stale', [])?.runId).toBe('r_msg')
  })

  it('is absent after a user turn or without anything to resume', () => {
    expect(resumePayload([{ id: 'u', role: 'user', parts: [] }], 'r', [])).toBeUndefined()
    expect(resumePayload([assistant([{ type: 'text', text: 'hi' }])], 'r', [])).toBeUndefined()
    expect(
      resumePayload(
        [
          assistant([
            { type: 'tool-x', toolCallId: 't', state: 'approval-responded', approval: { id: 'a' } },
          ]),
        ],
        undefined,
        [],
      ),
    ).toBeUndefined()
  })
})

describe('normalizeError', () => {
  it.each([
    [new HttpError(429, { code: 'rate_limited' }, 12), { code: 'rate_limited', retryAfter: 12 }],
    [new HttpError(429, {}), { code: 'rate_limited', retryAfter: 30 }],
    [new HttpError(402, {}), { code: 'budget_exceeded', retryable: false }],
    [new HttpError(410, { code: 'invalid_request' }), { code: 'run_expired', retryable: true }],
    [
      new HttpError(403, { code: 'origin_denied', message: 'Not allowed here.' }),
      { code: 'origin_denied', message: 'Not allowed here.' },
    ],
    [
      new HttpError(500, { code: 'internal_error', message: 'stack trace…' }),
      { code: 'provider_error', message: 'fallback' },
    ],
    [new TypeError('Failed to fetch'), { code: 'network', retryable: true }],
  ])('%s', (error, expected) => {
    expect(normalizeError(error, 'fallback')).toMatchObject(expected)
  })
})
