import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import {
  validateConfig,
  type DeepPartial,
  type ResolvedConfig,
  type SiteBotConfigInput,
} from '@sitebot/config'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { EngineDeps } from '@sitebot/core'

export const SESSION = 's_01J9X8Y7Z6ABCDEFGHJKMNPQRS'

export function testConfig(overrides: DeepPartial<SiteBotConfigInput> = {}): ResolvedConfig {
  const result = validateConfig(
    {
      version: 1,
      name: 'Acme',
      backend: { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'test-key-do-not-leak' },
      prompt: { system: 'You are Acme’s website assistant.' },
      ...overrides,
    },
    { env: {} },
  )
  if (!result.ok) {
    throw new Error(`test config did not validate: ${JSON.stringify(result.errors, null, 2)}`)
  }
  return result.value
}

/** A mock model that streams `chunks` as text deltas. No network, ever. */
export function textModel(chunks: string[]): MockLanguageModelV3 {
  const parts: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...chunks.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
    },
  ]

  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: parts,
        chunkDelayInMs: null,
        initialDelayInMs: null,
      }),
    }),
  })
}

export function mockDeps(chunks = ['Your order ', 'shipped yesterday.']): EngineDeps {
  const model = textModel(chunks)
  return { adapters: { anthropic: async () => model } }
}

export const chatBody = (text = 'Where is my order?') => ({
  sessionId: SESSION,
  messages: [{ id: 'm_1', role: 'user', parts: [{ type: 'text', text }] }],
})

/** Decode an SSE body into its assistant text. */
export async function streamedText(body: string): Promise<string> {
  let out = ''
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6)
    if (payload === '[DONE]') continue
    const parsed = JSON.parse(payload) as { type: string; delta?: string }
    if (parsed.type === 'text-delta' && typeof parsed.delta === 'string') out += parsed.delta
  }
  return out
}
