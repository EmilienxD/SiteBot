import { describe, expect, it } from 'vitest'
import { loadYamlFixture, minimalConfig } from '../test/helpers.js'
import { CONFIG_FILENAMES, CONFIG_SCHEMA_VERSION, validateConfig } from './index.js'

/** Every variable the kitchen-sink fixture references. */
const ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENAI_API_KEY: 'sk-openai-test',
  ACME_API_KEY: 'acme-test',
  MCP_TOKEN: 'mcp-test',
  SLACK_WEBHOOK: 'https://hooks.slack.test/abc',
  SITEBOT_JWT_SECRET: 'jwt-test-secret',
  EVENTS_WEBHOOK: 'https://events.acme.test/hook',
}

describe('kitchen-sink config (Phase 1 acceptance)', () => {
  const result = validateConfig(loadYamlFixture('kitchen-sink.yaml'), {
    env: ENV,
  })

  it('validates and resolves', () => {
    if (!result.ok) {
      throw new Error(
        `expected the fixture to validate, got:\n${JSON.stringify(result.errors, null, 2)}`,
      )
    }
    expect(result.ok).toBe(true)
  })

  it('covers every documented section', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A section missing from the fixture would let its schema rot untested.
    expect(Object.keys(result.value).sort()).toEqual(
      [
        '$meta',
        'agent',
        'backend',
        'mode',
        'name',
        'prompt',
        'security',
        'siteContext',
        'storage',
        'telemetry',
        'tools',
        'ui',
        'version',
      ].sort(),
    )
  })

  it('resolves ${env.*} in nested structures', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const config = result.value
    expect(config.backend.apiKey).toBe('sk-ant-test')
    expect(config.backend.fallback[1]?.apiKey).toBe('sk-openai-test')
    expect(config.security.auth.jwt?.secret).toBe('jwt-test-secret')
    expect(config.telemetry.events.webhook).toBe('https://events.acme.test/hook')
  })

  it('applies :- defaults when the variable is unset', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.prompt.variables['tier']).toBe('standard')
    expect(result.value.tools[0]?.enabled).toBe('true')
  })

  it('records every env-sourced path', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.$meta.envPaths).toEqual(
      expect.arrayContaining([
        'backend.apiKey',
        'backend.fallback[1].apiKey',
        'security.auth.jwt.secret',
        'tools[0].executor.headers.Authorization',
        'telemetry.events.webhook',
      ]),
    )
  })
})

describe('defaults', () => {
  const result = validateConfig(minimalConfig(), { env: {} })

  it('fills in the documented defaults', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const config = result.value

    expect(config.mode).toBe('chat')
    expect(config.tools).toEqual([])
    expect(config.storage.type).toBe('memory')
    expect(config.backend.maxOutputTokens).toBe(2048)
    expect(config.backend.timeoutMs).toBe(60_000)
    expect(config.backend.maxRetries).toBe(2)
    expect(config.prompt.includePageContext).toBe(true)
    expect(config.prompt.guardrails.maxUserMessageChars).toBe(8000)
    expect(config.security.auth.mode).toBe('optional')
    expect(config.security.allowedOrigins).toEqual([])
    expect(config.security.rateLimit.perSession).toBe('30/5m')
    expect(config.security.rateLimit.perIp).toBe('100/1h')
    expect(config.security.maxRequestBytes).toBe(262_144)
    expect(config.security.redactPii).toBe(false)
    expect(config.ui.zIndex).toBe(2_147_483_000)
    expect(config.ui.position).toBe('bottom-right')
    expect(config.telemetry.logLevel).toBe('info')
    expect(config.telemetry.redactPromptsInLogs).toBe(true)
  })

  it('defaults agent.stopWhen.steps to maxSteps', () => {
    const withAgent = validateConfig(
      { ...minimalConfig(), mode: 'agent', agent: { maxSteps: 5 } },
      { env: {} },
    )
    expect(withAgent.ok).toBe(true)
    if (!withAgent.ok) return
    expect(withAgent.value.agent.stopWhen.steps).toBe(5)
    expect(withAgent.value.agent.stopWhen.tokens).toBe(20_000)
  })

  it('falls back to `name` for the panel title (docs/02 §11)', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ui.panel.title).toBe('Acme')
  })
})

describe('required fields', () => {
  it.each([
    ['version', 'version'],
    ['name', 'name'],
    ['backend', 'backend'],
    ['prompt', 'prompt'],
  ])('rejects a config with no %s', (_label, key) => {
    const config = minimalConfig()
    delete config[key]
    const result = validateConfig(config, { env: {} })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((error) => error.path === key)).toBe(true)
  })

  it('pins the schema version at 1', () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(1)
    const result = validateConfig({ ...minimalConfig(), version: 2 }, { env: {} })
    expect(result.ok).toBe(false)
  })

  it('resolves TS config files before declarative ones (docs/02 §1)', () => {
    expect(CONFIG_FILENAMES.indexOf('chatbot.config.mjs')).toBeLessThan(
      CONFIG_FILENAMES.indexOf('chatbot.config.yaml'),
    )
    expect(CONFIG_FILENAMES.indexOf('chatbot.config.yaml')).toBeLessThan(
      CONFIG_FILENAMES.indexOf('chatbot.config.json'),
    )
    expect(CONFIG_FILENAMES.indexOf('chatbot.config.json')).toBeLessThan(
      CONFIG_FILENAMES.indexOf('chatbot.config.toml'),
    )
  })

  it('requires exactly one of prompt.system and prompt.systemFile', () => {
    const neither = validateConfig({ ...minimalConfig(), prompt: {} }, { env: {} })
    expect(neither.ok).toBe(false)

    const both = validateConfig(
      { ...minimalConfig(), prompt: { system: 'hi', systemFile: './p.md' } },
      { env: {} },
    )
    expect(both.ok).toBe(false)
    if (both.ok) return
    expect(both.errors[0]?.message).toContain('mutually exclusive')
  })

  it('enforces the tool name pattern (docs/05 §1)', () => {
    const result = validateConfig(
      {
        ...minimalConfig(),
        tools: [
          {
            parameters: { type: 'object' },
            outputSchema: {},
            name: 'Check-Order',
            description: 'Look up an order by ID.',
            readOnly: true,
            executor: { type: 'client', id: 'highlight' },
          },
        ],
      },
      { env: {} },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.path).toBe('tools[0].name')
  })
})
