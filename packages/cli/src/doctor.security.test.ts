import { describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import { findInlineSecrets, productionDoctor } from './index.js'

function productionConfig(overrides: Record<string, unknown> = {}) {
  const result = validateConfig(
    {
      version: 1,
      name: 'Acme',
      mode: 'agent',
      backend: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: '${env.OPENAI_API_KEY}',
      },
      prompt: { system: 'You are a safe assistant.' },
      siteContext: { routes: [{ path: '/account/orders' }] },
      knowledge: {
        sources: [
          {
            type: 'sitemap',
            url: 'https://acme.example/sitemap.xml',
            exclude: ['/account/**'],
          },
        ],
        embedding: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          apiKey: '${env.OPENAI_API_KEY}',
        },
      },
      storage: { type: 'sqlite', path: './.sitebot/sessions.db' },
      ui: {
        footer: { text: 'We record chats to improve support.' },
        pageContext: { excludePaths: ['/account/**'] },
      },
      security: {
        allowedOrigins: ['https://acme.example'],
        rateLimit: { store: 'redis', url: '${env.REDIS_URL}' },
        budget: { maxUsdPerDay: 25 },
        auth: { mode: 'required', jwt: { secret: '${env.JWT_SECRET}' } },
        trustProxy: 1,
      },
      telemetry: {
        events: {
          webhook: '${env.EVENTS_WEBHOOK}',
          include: ['budget_exceeded'],
        },
      },
      tools: [
        {
          name: 'create_ticket',
          description: 'Create a support ticket for the authenticated user.',
          readOnly: false,
          requiresApproval: true,
          scope: 'authenticated',
          parameters: { type: 'object', properties: {} },
          executor: {
            type: 'http',
            method: 'POST',
            url: 'https://api.example/tickets',
            allowHosts: ['api.example'],
            headers: {},
            query: {},
            maxResponseBytes: 1000,
            errorMap: {},
            allowPrivateNetwork: false,
            maxRedirects: 0,
          },
        },
      ],
      ...overrides,
    },
    {
      env: {
        OPENAI_API_KEY: 'sk-live-key-from-env',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'jwt-secret-from-env-with-enough-length',
        EVENTS_WEBHOOK: 'https://events.example/hook',
      },
    },
  )
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

describe('production doctor', () => {
  it('passes automated deployment controls and reports manual checks', () => {
    const report = productionDoctor(productionConfig(), { gitignore: '.env*\n' })

    expect(report.ok).toBe(true)
    expect(report.checks.filter((check) => check.manual).map((check) => check.label)).toEqual([
      'ingest freshness',
      'widget integrity',
    ])
    expect(report.checks.filter((check) => !check.manual && !check.ok)).toHaveLength(0)
  })

  it('finds literal provider secrets but ignores env-sourced values', () => {
    const config = productionConfig({
      backend: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-live-inline-secret-value',
      },
    })

    expect(findInlineSecrets(config)).toContain('backend.apiKey')
    expect(findInlineSecrets(productionConfig())).not.toContain('backend.apiKey')
  })
})
