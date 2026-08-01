import { describe, expect, it } from 'vitest'
import { minimalConfig } from '../test/helpers.js'
import { interpolateEnv, isEnvSourced, validateConfig } from './index.js'

describe('${env.*} interpolation (docs/02 §2)', () => {
  it('substitutes a bare placeholder', () => {
    const { value } = interpolateEnv({ key: '${env.API_KEY}' }, { env: { API_KEY: 'secret' } })
    expect(value).toEqual({ key: 'secret' })
  })

  it('substitutes inside surrounding text and more than once', () => {
    const { value } = interpolateEnv(
      { url: 'https://${env.HOST}:${env.PORT}/v1' },
      { env: { HOST: 'api.acme.com', PORT: '8443' } },
    )
    expect(value).toEqual({ url: 'https://api.acme.com:8443/v1' })
  })

  it('uses the :- default when the variable is unset or empty', () => {
    const { value, errors } = interpolateEnv(
      { a: '${env.MISSING:-3000}', b: '${env.EMPTY:-fallback}' },
      { env: { EMPTY: '' } },
    )
    expect(value).toEqual({ a: '3000', b: 'fallback' })
    expect(errors).toEqual([])
  })

  it('treats a missing variable as a fatal error, not an empty string', () => {
    const { errors } = interpolateEnv(
      { backend: { apiKey: '${env.ANTHROPIC_API_KEY}' } },
      { env: {} },
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('backend.apiKey')
    expect(errors[0]?.message).toBe('Environment variable ANTHROPIC_API_KEY is not set.')
    expect(errors[0]?.fix).toContain('${env.ANTHROPIC_API_KEY:-someValue}')
  })

  it('reports every missing variable at once', () => {
    const { errors } = interpolateEnv({ a: '${env.ONE}', b: { c: '${env.TWO}' } }, { env: {} })
    expect(errors.map((error) => error.path)).toEqual(['a', 'b.c'])
  })

  it('walks arrays and records indexed paths', () => {
    const { value, envPaths } = interpolateEnv(
      { fallback: [{ apiKey: '${env.K1}' }, { apiKey: '${env.K2}' }] },
      { env: { K1: 'one', K2: 'two' } },
    )
    expect(value).toEqual({ fallback: [{ apiKey: 'one' }, { apiKey: 'two' }] })
    expect(envPaths).toEqual(['fallback[0].apiKey', 'fallback[1].apiKey'])
  })

  it('leaves prompt.system literal so a secret cannot slide into the context', () => {
    const { value, envPaths, errors } = interpolateEnv(
      { prompt: { system: 'Key is ${env.ANTHROPIC_API_KEY}' } },
      { env: { ANTHROPIC_API_KEY: 'sk-secret' } },
    )
    expect(value).toEqual({
      prompt: { system: 'Key is ${env.ANTHROPIC_API_KEY}' },
    })
    expect(envPaths).toEqual([])
    expect(errors).toEqual([])
  })

  it('still interpolates prompt.variables', () => {
    const { value } = interpolateEnv(
      { prompt: { variables: { tier: '${env.DEPLOY_TIER}' } } },
      { env: { DEPLOY_TIER: 'enterprise' } },
    )
    expect(value).toEqual({ prompt: { variables: { tier: 'enterprise' } } })
  })

  it('leaves the ui block alone entirely', () => {
    const { value, envPaths } = interpolateEnv(
      { ui: { messages: { greeting: '${env.GREETING}' } } },
      { env: { GREETING: 'hi' } },
    )
    expect(value).toEqual({ ui: { messages: { greeting: '${env.GREETING}' } } })
    expect(envPaths).toEqual([])
  })

  it('does not mutate its input', () => {
    const input = { key: '${env.K}' }
    interpolateEnv(input, { env: { K: 'v' } })
    expect(input.key).toBe('${env.K}')
  })

  it('marks a path as env-sourced even when the default was used', () => {
    // Otherwise `toPublicConfig` would include a field on a machine where the
    // variable happens to be unset and drop it where it is set — a leak you
    // would only find in production.
    const { envPaths } = interpolateEnv({ a: '${env.NOPE:-x}' }, { env: {} })
    expect(envPaths).toEqual(['a'])
  })
})

describe('isEnvSourced', () => {
  const paths = ['security.auth.jwt', 'backend.apiKey']

  it('matches exactly', () => {
    expect(isEnvSourced('backend.apiKey', paths)).toBe(true)
  })

  it('matches descendants of an env-sourced path', () => {
    expect(isEnvSourced('security.auth.jwt.secret', paths)).toBe(true)
    expect(isEnvSourced('security.auth.jwt[0]', paths)).toBe(true)
  })

  it('does not match a path that merely shares a prefix', () => {
    expect(isEnvSourced('backend.apiKeyId', paths)).toBe(false)
    expect(isEnvSourced('security.auth.jwtSecret', paths)).toBe(false)
  })
})

describe('validateConfig and the environment', () => {
  it('fails validation when a variable is missing', () => {
    const result = validateConfig(
      {
        ...minimalConfig(),
        backend: {
          provider: 'anthropic',
          model: 'claude-opus-5',
          apiKey: '${env.ANTHROPIC_API_KEY}',
        },
      },
      { env: {} },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.rule).toBe('env/missing-variable')
  })

  it('never boots with an unresolved placeholder as a real value', () => {
    const result = validateConfig(
      {
        ...minimalConfig(),
        backend: {
          provider: 'anthropic',
          model: 'claude-opus-5',
          apiKey: '${env.ANTHROPIC_API_KEY}',
        },
      },
      { env: {} },
    )
    // The placeholder satisfies `apiKey: string`, so only the env check stands
    // between this config and a request signed with the literal text.
    expect(result.ok).toBe(false)
  })
})
