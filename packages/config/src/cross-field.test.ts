import { describe, expect, it } from 'vitest'
import { errorForRule, errorsFor, minimalConfig } from '../test/helpers.js'
import { validateConfig } from './index.js'

/**
 * The ten cross-field rules of docs/02-configuration.md §14, plus the three
 * stated elsewhere in the spec.
 *
 * Each asserts the *exact* message. These strings are what a developer reads at
 * 2am and what they paste into a search box, so changing one is an API change
 * and should show up as a failing test, not a silent improvement.
 */

const CLIENT_TOOL = {
  name: 'highlight_section',
  description: 'Scroll to and highlight a section of the page.',
  readOnly: true,
  executor: { type: 'client', id: 'highlight' },
}

describe('rule 1 — mode: chat forbids non-readOnly tools', () => {
  it('names every offending tool', () => {
    const error = errorForRule(
      {
        ...minimalConfig(),
        mode: 'chat',
        tools: [
          {
            name: 'create_ticket',
            description: 'File a support ticket.',
            executor: { type: 'client', id: 'x' },
          },
          {
            name: 'send_email',
            description: 'Send an email to the user.',
            executor: { type: 'client', id: 'y' },
          },
          CLIENT_TOOL,
        ],
      },
      'cross-field/1',
    )

    expect(error.message).toBe(
      'mode: chat allows only tools marked readOnly: true. These are not: create_ticket, send_email.',
    )
    expect(error.path).toBe('tools')
  })

  it('accepts the same tools in agent mode', () => {
    const result = validateConfig(
      {
        ...minimalConfig(),
        mode: 'agent',
        storage: { type: 'memory' },
        tools: [
          {
            name: 'create_ticket',
            description: 'File a support ticket.',
            executor: { type: 'client', id: 'x' },
          },
        ],
      },
      { env: {} },
    )
    expect(result.ok).toBe(true)
  })
})

describe('rule 2 — mode: agent forbids storage.type: none', () => {
  it('explains why statelessness is incompatible', () => {
    const error = errorForRule(
      { ...minimalConfig(), mode: 'agent', storage: { type: 'none' } },
      'cross-field/2',
    )

    expect(error.message).toBe(
      'mode: agent requires server-side session storage, but storage.type is "none".',
    )
    expect(error.path).toBe('storage.type')
  })

  it('allows storage.type: none in chat mode', () => {
    const result = validateConfig(
      { ...minimalConfig(), mode: 'chat', storage: { type: 'none' } },
      { env: {} },
    )
    expect(result.ok).toBe(true)
  })
})

describe('rule 3 — provider: openai-compatible requires baseUrl', () => {
  it('reports the primary backend', () => {
    const error = errorForRule(
      {
        ...minimalConfig(),
        backend: { provider: 'openai-compatible', model: 'mixtral-8x7b' },
      },
      'cross-field/3',
    )

    expect(error.message).toBe('provider "openai-compatible" requires a baseUrl.')
    expect(error.path).toBe('backend.baseUrl')
  })

  it('reports a fallback entry at its own path', () => {
    const error = errorForRule(
      {
        ...minimalConfig(),
        backend: {
          provider: 'anthropic',
          model: 'claude-opus-5',
          fallback: [
            { provider: 'openai', model: 'gpt-5' },
            { provider: 'openai-compatible', model: 'mixtral-8x7b' },
          ],
        },
      },
      'cross-field/3',
    )
    expect(error.path).toBe('backend.fallback[1].baseUrl')
  })
})

describe('rule 4 — provider: custom requires module', () => {
  it('asks for the factory path', () => {
    const error = errorForRule(
      { ...minimalConfig(), backend: { provider: 'custom', model: 'whatever' } },
      'cross-field/4',
    )

    expect(error.message).toBe(
      'provider "custom" requires a module path to a LanguageModel factory.',
    )
    expect(error.path).toBe('backend.module')
  })
})

describe('rule 5 — knowledge.sources requires knowledge.embedding', () => {
  it('fires when sources are configured without an embedder', () => {
    const error = errorForRule(
      {
        ...minimalConfig(),
        knowledge: {
          sources: [{ type: 'sitemap', url: 'https://acme.com/sitemap.xml' }],
        },
      },
      'cross-field/5',
    )

    expect(error.message).toBe(
      'knowledge.sources is not empty, so knowledge.embedding is required.',
    )
    expect(error.path).toBe('knowledge.embedding')
  })

  it('stays quiet when there are no sources', () => {
    const result = validateConfig(
      { ...minimalConfig(), knowledge: { retrieval: { topK: 3 } } },
      { env: {} },
    )
    expect(result.ok).toBe(true)
  })
})

describe('rule 6 — sqlite store is rejected on edge', () => {
  const config = {
    ...minimalConfig(),
    knowledge: {
      sources: [{ type: 'text', id: 'faq', content: 'Returns take 30 days.' }],
      embedding: { provider: 'openai', model: 'text-embedding-3-small' },
      store: { type: 'sqlite', path: './.sitebot/index.db' },
    },
  }

  it('fires only for the edge target', () => {
    const result = validateConfig(config, { env: {}, target: 'edge' })
    expect(result.ok).toBe(false)
    if (result.ok) return

    const error = result.errors.find((e) => e.rule === 'cross-field/6')
    expect(error?.message).toBe(
      'knowledge.store.type "sqlite" is not available on the edge runtime.',
    )
    expect(error?.path).toBe('knowledge.store.type')
  })

  it('is fine on node', () => {
    expect(validateConfig(config, { env: {}, target: 'node' }).ok).toBe(true)
  })
})

describe('rule 7 — auth.mode: required needs a jwt block', () => {
  it('says what verification needs', () => {
    const error = errorForRule(
      { ...minimalConfig(), security: { auth: { mode: 'required' } } },
      'cross-field/7',
    )

    expect(error.message).toBe(
      'security.auth.mode "required" needs security.auth.jwt to verify tokens with.',
    )
    expect(error.path).toBe('security.auth.jwt')
  })
})

describe('rule 8 — scope: authenticated needs auth', () => {
  it('names the tool and the current mode', () => {
    const error = errorForRule(
      {
        ...minimalConfig(),
        security: { auth: { mode: 'none' } },
        tools: [
          {
            name: 'check_order_status',
            description: 'Look up an order by ID.',
            readOnly: true,
            scope: 'authenticated',
            executor: { type: 'client', id: 'x' },
          },
        ],
      },
      'cross-field/8',
    )

    expect(error.message).toBe(
      'Tool "check_order_status" has scope: authenticated, but security.auth.mode is "none" — there is no verified identity to check against.',
    )
    expect(error.path).toBe('tools[0].scope')
  })

  it('is satisfied by auth.mode: optional', () => {
    const result = validateConfig(
      {
        ...minimalConfig(),
        security: { auth: { mode: 'optional' } },
        tools: [
          {
            name: 'check_order_status',
            description: 'Look up an order by ID.',
            readOnly: true,
            scope: 'authenticated',
            executor: { type: 'client', id: 'x' },
          },
        ],
      },
      { env: {} },
    )
    expect(result.ok).toBe(true)
  })
})

describe('rule 9 — suggestion tools must exist', () => {
  it('names the missing tool', () => {
    const error = errorForRule(
      {
        ...minimalConfig(),
        ui: {
          messages: {
            suggestions: [
              {
                label: 'Chat with Sales',
                action: { type: 'tool', tool: 'handoff_to_human' },
              },
            ],
          },
        },
      },
      'cross-field/9',
    )

    expect(error.message).toBe(
      'Suggestion action refers to tool "handoff_to_human", which is not configured.',
    )
    expect(error.path).toBe('ui.messages.suggestions[0].action.tool')
  })

  it('suggests the nearest configured name', () => {
    const error = errorForRule(
      {
        ...minimalConfig(),
        tools: [CLIENT_TOOL],
        ui: {
          messages: {
            suggestions: [
              {
                label: 'Show me',
                action: { type: 'tool', tool: 'highlight_sections' },
              },
            ],
          },
        },
      },
      'cross-field/9',
    )
    expect(error.suggestion).toBe('highlight_section')
  })
})

describe('rule 10 — ui may not contain ${env.*}', () => {
  it('reports the exact path of the placeholder', () => {
    const error = errorForRule(
      {
        ...minimalConfig(),
        ui: { messages: { greeting: 'Hello from ${env.DEPLOY_TIER}' } },
      },
      'cross-field/10',
    )

    expect(error.message).toBe(
      'ui must not contain ${env.*} — the whole block is served to the browser.',
    )
    expect(error.path).toBe('ui.messages.greeting')
  })

  it('fires even when the variable is set, so the leak cannot hide', () => {
    const result = validateConfig(
      {
        ...minimalConfig(),
        ui: { footer: { text: '${env.LEGAL_NOTICE}' } },
      },
      { env: { LEGAL_NOTICE: 'Recorded.' } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.rule).toBe('cross-field/10')
  })
})

describe('additional normative rules', () => {
  it('rejects duplicate tool names (docs/05 §1)', () => {
    const error = errorForRule(
      {
        ...minimalConfig(),
        tools: [CLIENT_TOOL, { ...CLIENT_TOOL, description: 'Another one.' }],
      },
      'tools/duplicate-name',
    )
    expect(error.message).toBe(
      'Duplicate tool name "highlight_section" — already defined at tools[0].',
    )
  })

  it('rejects mcp stdio on edge (docs/05 §3)', () => {
    const config = {
      ...minimalConfig(),
      tools: [
        {
          from: 'mcp',
          id: 'local',
          server: { transport: 'stdio', command: 'node', args: ['./mcp.js'] },
          allow: ['search_docs'],
          readOnly: true,
        },
      ],
    }

    expect(validateConfig(config, { env: {}, target: 'node' }).ok).toBe(true)

    const result = validateConfig(config, { env: {}, target: 'edge' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.find((e) => e.rule === 'tools/stdio-on-edge')?.message).toBe(
      'MCP transport "stdio" is not available on the edge runtime.',
    )
  })

  it('rejects "*" as an allowed origin (docs/08 §7)', () => {
    const error = errorForRule(
      { ...minimalConfig(), security: { allowedOrigins: ['*'] } },
      'security/wildcard-origin',
    )
    expect(error.message).toBe(
      '"*" is not an allowed origin — list the origins that may embed the widget.',
    )
  })

  it('accepts a single-level wildcard subdomain', () => {
    const result = validateConfig(
      {
        ...minimalConfig(),
        security: { allowedOrigins: ['https://*.acme.com'] },
      },
      { env: {} },
    )
    expect(result.ok).toBe(true)
  })
})

describe('warnings', () => {
  it('warns when an MCP import has no allow list', () => {
    const result = validateConfig(
      {
        ...minimalConfig(),
        mode: 'agent',
        tools: [
          {
            from: 'mcp',
            id: 'acme',
            server: { transport: 'http', url: 'https://acme.com/mcp' },
          },
        ],
      },
      { env: {} },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings[0]?.rule).toBe('tools/mcp-allow-missing')
    expect(result.warnings[0]?.message).toBe(
      'MCP import "acme" has no `allow` list, so every tool the server exposes is imported.',
    )
  })

  it('promotes that warning to an error under security.strictTools', () => {
    const errors = errorsFor({
      ...minimalConfig(),
      mode: 'agent',
      security: { strictTools: true },
      tools: [
        {
          from: 'mcp',
          id: 'acme',
          server: { transport: 'http', url: 'https://acme.com/mcp' },
        },
      ],
    })
    expect(errors.some((e) => e.rule === 'tools/mcp-allow-required')).toBe(true)
  })

  it('warns that an env-sourced name will not reach the browser', () => {
    const result = validateConfig(
      { ...minimalConfig(), name: '${env.SITE_NAME}' },
      { env: { SITE_NAME: 'Acme' } },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some((w) => w.rule === 'public/env-sourced-field')).toBe(true)
  })
})
