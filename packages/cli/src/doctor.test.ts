import { describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import { diagnose } from './commands/doctor.js'
import { Prompter } from './prompt.js'
import { Ui, formatMs } from './terminal.js'

function baseInput(): Record<string, unknown> {
  return {
    version: 1,
    name: 'Acme',
    backend: { provider: 'openai', model: 'gpt-4o-mini', apiKey: '${env.OPENAI_API_KEY}' },
    prompt: { system: 'You are a helpful assistant for Acme.' },
  }
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  const result = validateConfig(
    { ...baseInput(), ...overrides },
    { env: { OPENAI_API_KEY: 'sk-test-key-value-long-enough-123' } },
  )
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

describe('doctor diagnose (offline, no network)', () => {
  it('fails loudly when the provider key is missing', async () => {
    // `${env.X:-}` resolves a missing var to empty rather than failing the
    // schema, which is exactly the state doctor is for.
    const result = validateConfig(
      {
        version: 1,
        name: 'Acme',
        backend: { provider: 'openai', model: 'gpt-4o-mini', apiKey: '${env.OPENAI_API_KEY:-}' },
        prompt: { system: 'You are a helpful assistant for Acme.' },
      } as never,
      { env: {} },
    )
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    const report = await diagnose(result.value, { cwd: process.cwd(), env: {}, offline: true })
    const envCheck = report.checks.find((check) => check.name === 'env OPENAI_API_KEY')
    expect(envCheck?.status).toBe('fail')
    expect(envCheck?.fix).toContain('.env.local')
    expect(report.ok).toBe(false)
  })

  it('masks enough of a set key to recognise it without leaking it', async () => {
    const report = await diagnose(makeConfig(), {
      cwd: process.cwd(),
      env: { OPENAI_API_KEY: 'sk-abcd-secret-value-9x' },
      offline: true,
    })
    const envCheck = report.checks.find((check) => check.name === 'env OPENAI_API_KEY')
    expect(envCheck?.status).toBe('pass')
    expect(envCheck?.detail).toContain('sk-a')
    expect(envCheck?.detail).toContain('…9x')
    expect(envCheck?.detail).not.toContain('secret-value')
  })

  it('rejects a wildcard origin', async () => {
    // A wildcard fails schema validation, so this asserts the cross-field
    // failure at that layer rather than diagnosing an impossible config.
    const result = validateConfig(
      { ...baseInput(), security: { allowedOrigins: ['*'] } } as never,
      { env: { OPENAI_API_KEY: 'sk-x' } },
    )
    if (result.ok) throw new Error('expected validation to fail')
    expect(JSON.stringify(result.errors)).toContain('wildcard')
  })

  it('warns on plaintext http origins', async () => {
    const http = await diagnose(
      makeConfig({ security: { allowedOrigins: ['http://acme.com', 'https://ok.com'] } }),
      { cwd: process.cwd(), env: {}, offline: true },
    )
    const cors = http.checks.find((check) => check.name === 'cors')
    expect(cors?.status).toBe('warn')
    expect(cors?.detail).toContain('plaintext http')
  })

  it('skips knowledge checks when no sources are configured', async () => {
    const report = await diagnose(makeConfig(), { cwd: process.cwd(), env: {}, offline: true })
    expect(report.checks.find((check) => check.name === 'knowledge')?.status).toBe('skip')
  })

  it('flags literal secrets inline in the config', async () => {
    const report = await diagnose(
      makeConfig({
        backend: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          apiKey: 'sk-inline-secret-with-plenty-of-length',
        },
      }),
      { cwd: process.cwd(), env: {}, offline: true },
    )
    const secrets = report.checks.find((check) => check.name === 'inline secrets')
    expect(secrets?.status).toBe('fail')
    expect(secrets?.detail).toContain('backend.apiKey')
  })
})

describe('Prompter', () => {
  const ui = new Ui({ color: false, write: () => {} })

  it('consumes scripted answers in order', async () => {
    const prompter = new Prompter({
      ui,
      answers: ['Anthropic', '2', 'y'],
      input: process.stdin,
      output: process.stdout,
    })
    expect(await prompter.text('Name', 'default')).toBe('Anthropic')
    expect(
      await prompter.select(
        'Provider',
        [
          { value: 'anthropic', label: 'Anthropic' },
          { value: 'openai', label: 'OpenAI' },
        ],
        'anthropic',
      ),
    ).toBe('openai')
    expect(await prompter.confirm('Continue?', false)).toBe(true)
  })

  it('returns defaults non-interactively instead of hanging', async () => {
    const prompter = new Prompter({ ui, interactive: false })
    expect(await prompter.text('Name', 'Acme')).toBe('Acme')
    expect(await prompter.confirm('Continue?', true)).toBe(true)
  })
})

describe('formatMs', () => {
  it('scales from ms to minutes', () => {
    expect(formatMs(120)).toBe('120ms')
    expect(formatMs(2500)).toBe('2.5s')
    expect(formatMs(90_000)).toBe('2m')
  })
})
