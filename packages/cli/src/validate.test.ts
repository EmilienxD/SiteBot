import { describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import { contrastRatio, maskConfig } from './commands/validate.js'

function config(overrides: Record<string, unknown> = {}) {
  const result = validateConfig(
    {
      version: 1,
      name: 'Acme',
      backend: { provider: 'openai', model: 'gpt-4o-mini', apiKey: '${env.OPENAI_API_KEY}' },
      prompt: { system: 'You are a helpful assistant for Acme.' },
      security: {
        rateLimit: { store: 'redis', url: '${env.REDIS_URL}' },
        publicKey: 'pk_live_public_identifier',
      },
      ...overrides,
    },
    {
      env: {
        OPENAI_API_KEY: 'sk-live-secret-value-long-enough',
        REDIS_URL: 'redis://:pw@host:6379',
      },
    },
  )
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

describe('maskConfig', () => {
  it('masks env-sourced values and secret-shaped paths', () => {
    const masked = maskConfig(config())
    const backend = masked['backend'] as Record<string, unknown>
    const rateLimit = (masked['security'] as Record<string, unknown>)['rateLimit'] as Record<
      string,
      unknown
    >
    expect(backend['apiKey']).toBe('***')
    expect(rateLimit['url']).toBe('***')
  })

  it('keeps the public key visible — it is an identifier, not a secret (docs/02 §12)', () => {
    const masked = maskConfig(config())
    expect((masked['security'] as Record<string, unknown>)['publicKey']).toBe(
      'pk_live_public_identifier',
    )
  })

  it('masks literal secrets by key name even when not env-sourced', () => {
    const masked = maskConfig(
      config({ backend: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-literal' } }),
    )
    expect((masked['backend'] as Record<string, unknown>)['apiKey']).toBe('***')
  })

  it('shows everything under --show-secrets, and always drops $meta', () => {
    const shown = maskConfig(config(), true)
    expect((shown['backend'] as Record<string, unknown>)['apiKey']).toBe(
      'sk-live-secret-value-long-enough',
    )
    expect(shown).not.toHaveProperty('$meta')
  })
})

describe('contrastRatio', () => {
  it('passes black-on-white and fails low-contrast pairs', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0)
    expect(contrastRatio('#dddddd', '#e0e0e0') as number).toBeLessThan(4.5)
  })

  it('returns null for colours it cannot parse', () => {
    expect(contrastRatio('rebeccapurple', '#000')).toBeNull()
  })
})
