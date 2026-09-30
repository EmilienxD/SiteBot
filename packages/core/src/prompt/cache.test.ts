import { describe, expect, it } from 'vitest'
import { testConfig } from '../../test/helpers.js'
import { composePrompt } from './compose.js'
import { cachedSystem } from './cache.js'

const config = testConfig({
  prompt: { system: 'You are Acme’s assistant.', guardrails: { refuseOffTopic: true } },
  siteContext: { company: 'Acme' },
})
const compose = (extract: string) =>
  composePrompt({
    config,
    ctx: { pageContext: { extract } },
    documents: [{ id: 'd', text: extract }],
  })

describe('explicit provider cache boundaries', () => {
  it.each(['anthropic', 'bedrock'] as const)(
    'marks only stable prefixes for %s and leaves changing random delimiters after them',
    (provider) => {
      const first = compose('first page')
      const second = compose('different page')
      const messages = cachedSystem(provider, first.text, first)
      const next = cachedSystem(provider, second.text, second)
      expect(Array.isArray(messages)).toBe(true)
      if (!Array.isArray(messages) || !Array.isArray(next)) throw new Error('expected messages')
      expect(messages.slice(0, 2)).toEqual(next.slice(0, 2))
      expect(messages[0]?.providerOptions).toEqual(
        provider === 'anthropic'
          ? { anthropic: { cacheControl: { type: 'ephemeral' } } }
          : { bedrock: { cachePoint: { type: 'default' } } },
      )
      expect(messages[1]?.providerOptions).toBeDefined()
      expect(messages[2]?.providerOptions).toBeUndefined()
      expect(messages[2]?.content).toContain(first.delimiterId)
      expect(messages.map((message) => message.content).join('\n\n')).toBe(first.text)
    },
  )
  it('does not send foreign provider metadata or infer boundaries in rewritten hooks', () => {
    const prompt = compose('page')
    for (const provider of ['openai', 'google', 'vertex', 'custom'] as const) {
      expect(cachedSystem(provider, prompt.text, prompt)).toBe(prompt.text)
    }
    expect(cachedSystem('anthropic', 'rewritten', prompt)).toBe('rewritten')
  })
})
