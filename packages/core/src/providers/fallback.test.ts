import { describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import { backoffDelay, classifyError } from './fallback.js'
import { resolveChain } from './registry.js'

/** docs/04 §3 rules 1–3. */
describe('classifyError', () => {
  it.each([429, 500, 502, 503, 504])('retries status %i within the provider', (status) => {
    expect(classifyError(Object.assign(new Error('x'), { statusCode: status }))).toBe('retryable')
  })

  it.each([400, 401, 403, 404])('never retries status %i', (status) => {
    expect(classifyError(Object.assign(new Error('x'), { statusCode: status }))).toBe('fatal')
  })

  it.each(['ECONNRESET', 'ETIMEDOUT'])('retries a %s connection error', (code) => {
    expect(classifyError(Object.assign(new Error('socket'), { code }))).toBe('retryable')
  })

  it('retries a timeout', () => {
    expect(classifyError(new Error('Request timed out'))).toBe('retryable')
  })

  it.each([
    'This model maximum context length is 128000 tokens',
    'context_length_exceeded',
    'The response was filtered due to the content_filter policy',
  ])('never retries "%s", even on a 5xx status', (message) => {
    // A prompt that is too long stays too long; a filter refuses again.
    expect(classifyError(Object.assign(new Error(message), { statusCode: 500 }))).toBe('fatal')
  })

  it('treats an unknown error as fatal rather than gambling on a retry', () => {
    expect(classifyError(new Error('something odd'))).toBe('fatal')
  })
})

describe('backoffDelay', () => {
  const mid = () => 0.5 // no jitter

  it('starts at 250 ms and doubles', () => {
    expect([0, 1, 2].map((attempt) => backoffDelay(attempt, { random: mid }))).toEqual([
      250, 500, 1000,
    ])
  })

  it('jitters by at most ±20%', () => {
    expect(backoffDelay(0, { random: () => 0 })).toBe(200)
    expect(backoffDelay(0, { random: () => 0.999_999 })).toBe(300)
  })
})

describe('resolveChain (docs/04 §3 rule 4)', () => {
  it("fallback entries inherit the primary's settings unless they override them", () => {
    const result = validateConfig(
      {
        version: 1,
        name: 'Acme',
        prompt: { system: 'You help.' },
        backend: {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          temperature: 0.2,
          maxOutputTokens: 700,
          fallback: [
            { provider: 'openai', model: 'gpt-5-mini' },
            { provider: 'openai', model: 'gpt-5', temperature: 0.9 },
          ],
        },
      },
      { env: {} },
    )
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    const [, first, second] = resolveChain(result.value.backend)
    expect(first).toMatchObject({ model: 'gpt-5-mini', temperature: 0.2, maxOutputTokens: 700 })
    expect(second).toMatchObject({ model: 'gpt-5', temperature: 0.9, maxOutputTokens: 700 })
  })
})
