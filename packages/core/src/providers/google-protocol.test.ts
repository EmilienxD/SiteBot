import { describe, expect, it, vi } from 'vitest'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createVertex } from '@ai-sdk/google-vertex'
import { createEngine } from '../engine.js'
import { MemorySessionStore } from '../session/store.js'
import type { ToolContext } from '../types.js'
import { readSse, testConfig, testContext, userMessage } from '../../test/helpers.js'

type Provider = 'google' | 'vertex'
interface NativeRequest {
  toolConfig?: { functionCallingConfig?: { mode?: string } }
  tools?: Array<{
    functionDeclarations?: Array<{
      name: string
      parametersJsonSchema?: unknown
      parameters?: unknown
    }>
  }>
  contents: Array<{ role: string; parts: unknown[] }>
}

/** Offline responses at the real SDK's fetch boundary, not model-option mocks. */
function nativeResponse(value: { call: string } | { text: string }): Response {
  const part =
    'call' in value
      ? {
          functionCall: { name: value.call, args: { query: 'public guide' } },
          thoughtSignature: 'offline-signature',
        }
      : { text: value.text }
  return new Response(
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
    })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function offlineProvider(
  provider: Provider,
  reply: (body: NativeRequest, index: number) => Response,
) {
  const requests: NativeRequest[] = []
  const getAccessToken = vi.fn(async () => ({ token: 'offline-test-token' }))
  const fetchImpl: typeof fetch = async (url, init) => {
    // A custom fetch and an injected auth client prevent inference and ADC requests.
    expect(String(url)).toContain(
      provider === 'vertex'
        ? '/projects/offline-project/locations/global/publishers/google/'
        : '/models/',
    )
    if (provider === 'vertex')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer offline-test-token')
    const body = JSON.parse(String(init?.body)) as NativeRequest
    requests.push(body)
    return reply(body, requests.length - 1)
  }
  type AuthClient = NonNullable<
    NonNullable<Parameters<typeof createVertex>[0]>['googleAuthOptions']
  >['authClient']
  const model =
    provider === 'vertex'
      ? createVertex({
          apiKey: '',
          project: 'offline-project',
          location: 'global',
          // The adapter only calls getAccessToken; do not construct a real ADC client.
          googleAuthOptions: { authClient: { getAccessToken } as unknown as AuthClient },
          fetch: fetchImpl,
        })('gemini-3.5-flash-lite')
      : createGoogleGenerativeAI({ apiKey: 'offline-test-key', fetch: fetchImpl })(
          'gemini-3.5-flash-lite',
        )
  return { model, requests, getAccessToken }
}

const declarations = (request: NativeRequest) =>
  request.tools?.flatMap((tool) => tool.functionDeclarations ?? []) ?? []
const chunks = async (response: Response) =>
  (await readSse(response)).filter((line) => line !== '[DONE]').map((line) => JSON.parse(line))

async function summaryTurn(
  provider: Provider,
  final: 'answer' | 'registered' | 'unknown' = 'answer',
  maxSteps = 4,
) {
  const transport = offlineProvider(provider, (_body, index) =>
    nativeResponse(
      index < maxSteps - 1
        ? { call: 'lookup' }
        : final === 'answer'
          ? { text: 'The public guide supports this answer. [1]' }
          : { call: final === 'registered' ? 'lookup' : 'unregistered_action' },
    ),
  )
  const execute = vi.fn((_input: unknown, ctx: ToolContext) => {
    const source = ctx.sources.register({
      id: 'public-guide',
      url: 'https://example.test/guide',
      title: 'Guide',
      text: 'Public guide evidence.',
      lang: 'en',
    })
    return { n: source.n, excerpt: 'Public guide evidence.' }
  })
  const excluded = vi.fn(),
    observed = vi.fn(),
    errors = vi.fn(),
    store = new MemorySessionStore()
  const config = testConfig({
    backend: {
      provider,
      model: 'gemini-3.5-flash-lite',
      maxRetries: 0,
      maxOutputTokens: 900,
      timeoutMs: 30_000,
    },
    agent: {
      maxSteps,
      parallelToolCalls: false,
      stopWhen: { tokens: 12_000, seconds: 45 },
      onMaxSteps: 'summarize',
    },
    hooks: { onToolCall: observed, onError: errors },
    tools: [
      {
        name: 'lookup',
        description: 'Look up application public guide evidence.',
        readOnly: true,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', maxLength: 100 } },
          required: ['query'],
          additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        execute,
      },
      {
        name: 'disabled_action',
        description: 'Disabled application tool.',
        enabled: false,
        readOnly: true,
        parameters: { type: 'object' },
        outputSchema: {},
        execute: excluded,
      },
      {
        name: 'private_action',
        description: 'Authenticated application tool.',
        scope: 'authenticated',
        readOnly: true,
        parameters: { type: 'object' },
        outputSchema: {},
        execute: excluded,
      },
    ],
  })
  const engine = createEngine(config, {
    sessionStore: store,
    adapters: { [provider]: async () => transport.model },
  })
  const ctx = testContext()
  try {
    const events = await chunks(
      await engine.handleChat(
        { sessionId: ctx.sessionId, messages: [userMessage('What does the guide say?')] },
        ctx,
      ),
    )
    return {
      ...transport,
      events,
      execute,
      excluded,
      observed,
      errors,
      session: await store.get(ctx.sessionId),
    }
  } finally {
    await engine.dispose()
  }
}

describe.each(['google', 'vertex'] as const)(
  '%s native function calling protocol (offline)',
  (provider) => {
    it('serializes native NONE on the fourth reserved summary request, retaining only eligible application schemas', async () => {
      const result = await summaryTurn(provider)
      expect(result.requests).toHaveLength(4)
      expect(result.execute).toHaveBeenCalledTimes(3)
      expect(result.observed).toHaveBeenCalledTimes(3)
      expect(result.excluded).not.toHaveBeenCalled()
      expect(result.requests[3]?.toolConfig?.functionCallingConfig?.mode).toBe('NONE')
      expect(declarations(result.requests[3]!).map((tool) => tool.name)).toEqual(['lookup'])
      expect(declarations(result.requests[3]!)[0]?.parameters).toMatchObject({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      })
      expect(
        result.events.some(
          (event) => event.type === 'text-delta' && event.delta.includes('public guide'),
        ),
      ).toBe(true)
      expect(result.events.filter((event) => event.type === 'data-error')).toEqual([])
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: 'data-citations',
          data: expect.objectContaining({
            items: [expect.objectContaining({ chunkId: 'public-guide' })],
          }),
        }),
      )
      expect(result.session?.state?.pendingRun).toBeUndefined()
      if (provider === 'vertex') expect(result.getAccessToken).toHaveBeenCalledTimes(4)
    })

    it.each(['registered', 'unknown'] as const)(
      'cannot execute a %s call returned despite native NONE on the final step',
      async (returned) => {
        const result = await summaryTurn(provider, returned)
        expect(result.requests).toHaveLength(4)
        expect(result.requests[3]?.toolConfig?.functionCallingConfig?.mode).toBe('NONE')
        expect(result.execute).toHaveBeenCalledTimes(3)
        expect(result.observed).toHaveBeenCalledTimes(3)
        expect(result.excluded).not.toHaveBeenCalled()
        expect(result.events.filter((event) => event.type === 'data-error')).toMatchObject([
          { data: { code: 'provider_error' } },
        ])
        expect(result.errors).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'AI_ToolChoiceViolationError',
            toolChoice: { type: 'none' },
          }),
          expect.anything(),
        )
        expect(result.events).toContainEqual({ type: 'finish', finishReason: 'error' })
        expect(result.events.filter((event) => event.type === 'data-citations')).toHaveLength(1)
        expect(result.session?.state?.pendingRun).toBeUndefined()
      },
    )

    it('starts with native NONE when maxSteps=1 and runs no handler', async () => {
      const result = await summaryTurn(provider, 'answer', 1)
      expect(result.requests).toHaveLength(1)
      expect(result.requests[0]?.toolConfig?.functionCallingConfig?.mode).toBe('NONE')
      expect(result.execute).not.toHaveBeenCalled()
      expect(result.observed).not.toHaveBeenCalled()
    })

    it('allows an ordinary answer to finish before the reserved summary', async () => {
      const transport = offlineProvider(provider, () =>
        nativeResponse({ text: 'Ordinary answer.' }),
      )
      const execute = vi.fn()
      const engine = createEngine(
        testConfig({
          backend: { provider, model: 'gemini-3.5-flash-lite', maxRetries: 0 },
          tools: [
            {
              name: 'lookup',
              description: 'Read public information.',
              readOnly: true,
              parameters: { type: 'object' },
              outputSchema: {},
              execute,
            },
          ],
        }),
        { adapters: { [provider]: async () => transport.model } },
      )
      const ctx = testContext()
      try {
        const events = await chunks(
          await engine.handleChat({ sessionId: ctx.sessionId, messages: [userMessage('Hi')] }, ctx),
        )
        expect(transport.requests).toHaveLength(1)
        expect(declarations(transport.requests[0]!).map((tool) => tool.name)).toEqual(['lookup'])
        expect(transport.requests[0]?.toolConfig?.functionCallingConfig?.mode).toBe('AUTO')
        expect(events.filter((event) => event.type === 'data-error')).toEqual([])
        expect(execute).not.toHaveBeenCalled()
      } finally {
        await engine.dispose()
      }
    })

    it.each([false, true])(
      'empty application registry serializes no declarations and cannot execute invented calls (malicious=%s)',
      async (malicious) => {
        const transport = offlineProvider(provider, () =>
          nativeResponse(malicious ? { call: 'unregistered_action' } : { text: 'Plain answer.' }),
        )
        const observed = vi.fn()
        const engine = createEngine(
          testConfig({
            backend: { provider, model: 'gemini-3.5-flash-lite', maxRetries: 0 },
            agent: { maxSteps: 1 },
            tools: [],
            hooks: { onToolCall: observed },
          }),
          { adapters: { [provider]: async () => transport.model } },
        )
        const ctx = testContext()
        try {
          const events = await chunks(
            await engine.handleChat(
              { sessionId: ctx.sessionId, messages: [userMessage('Hi')] },
              ctx,
            ),
          )
          expect(transport.requests).toHaveLength(1)
          expect(transport.requests[0]?.tools).toBeUndefined()
          expect(declarations(transport.requests[0]!)).toEqual([])
          expect(observed).not.toHaveBeenCalled()
          expect(events.filter((event) => event.type === 'data-error')).toHaveLength(
            malicious ? 1 : 0,
          )
        } finally {
          await engine.dispose()
        }
      },
    )
  },
)
