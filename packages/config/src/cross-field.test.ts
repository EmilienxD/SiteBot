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
  parameters: { type: 'object' },
  outputSchema: {},
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
            parameters: { type: 'object' },
            outputSchema: {},
            name: 'create_ticket',
            description: 'File a support ticket.',
            executor: { type: 'client', id: 'x' },
          },
          {
            parameters: { type: 'object' },
            outputSchema: {},
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
            parameters: { type: 'object' },
            outputSchema: {},
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
            parameters: { type: 'object' },
            outputSchema: {},
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
            parameters: { type: 'object' },
            outputSchema: {},
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

describe('http tool templating (docs/05 §2 rules 2–3)', () => {
  const httpTool = (executor: Record<string, unknown>) => ({
    ...minimalConfig(),
    tools: [
      {
        parameters: { type: 'object' },
        outputSchema: {},
        name: 'lookup',
        description: 'Look something up. Use when asked.',
        readOnly: true,
        executor: { type: 'http', url: 'https://api.acme.com/v1/{id}', ...executor },
      },
    ],
  })

  it('accepts parameters in the path and query, and trusted context in headers', () => {
    const result = validateConfig(
      httpTool({
        url: 'https://api.acme.com/v1/orders/{id}',
        query: { q: '{term}' },
        headers: { authorization: 'Bearer ${env.TOKEN}', 'x-user': '{{identity.sub}}' },
      }),
      { env: { TOKEN: 'secret' } },
    )
    expect(result.ok ? [] : result.errors).toEqual([])
  })

  it.each(['https://{host}/v1/x', '{scheme}://api.acme.com/v1/x', 'https://api.{env}.acme.com/x'])(
    'rejects a parameter in the scheme or host: %s',
    (url) => {
      expect(errorForRule(httpTool({ url }), 'tools/param-in-host').path).toBe(
        'tools[0].executor.url',
      )
    },
  )

  it('rejects a parameter in a header value, even beside trusted context', () => {
    const error = errorForRule(
      httpTool({ headers: { authorization: 'Bearer {token} {{identity.sub}}' } }),
      'tools/param-in-header',
    )
    expect(error.path).toBe('tools[0].executor.headers.authorization')
  })

  it('rejects a parameter in a header name', () => {
    errorForRule(httpTool({ headers: { 'x-{name}': 'static' } }), 'tools/param-in-header')
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
          name: 'search_docs',
          description: 'Search test documents.',
          parameters: { type: 'object' },
          outputSchema: {},
          executor: {
            type: 'mcp',
            tool: 'search_docs',
            server: { transport: 'stdio', command: 'node', args: ['./mcp.js'] },
          },
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
  it('rejects the removed bulk import shape regardless of strictTools', () => {
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
    expect(errors.some((e) => e.path.startsWith('tools[0]'))).toBe(true)
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

  describe('docs/05 §7 rule 5 — writable tools reachable without approval', () => {
    const writable = {
      parameters: { type: 'object' },
      outputSchema: {},
      name: 'fill_wholesale_form',
      description: 'Prefill the wholesale form.',
      readOnly: false,
      executor: { type: 'client', id: 'fill_form' },
    }
    const unapproved = (overrides: Record<string, unknown>) => {
      const result = validateConfig(
        { ...minimalConfig(), mode: 'agent', storage: { type: 'memory' }, ...overrides },
        { env: {} },
      )
      if (!result.ok) throw new Error(JSON.stringify(result.errors))
      return result.warnings.filter((w) => w.rule === 'tools/unapproved-writable')
    }

    it('warns on a writable tool that is not approval-gated', () => {
      expect(unapproved({ tools: [writable] })).toEqual([
        expect.objectContaining({
          path: 'tools[0]',
          message:
            'Writable tool "fill_wholesale_form" runs without an approval card: it is not readOnly and not approval-gated.',
        }),
      ])
    })

    it('is satisfied by requiresApproval or agent.approvalRequired', () => {
      expect(unapproved({ tools: [{ ...writable, requiresApproval: true }] })).toEqual([])
      expect(
        unapproved({ tools: [writable], agent: { approvalRequired: ['fill_wholesale_form'] } }),
      ).toEqual([])
    })

    it('still warns under approvalPolicy: never, whatever the tool declares', () => {
      const [warning] = unapproved({
        tools: [{ ...writable, requiresApproval: true }],
        agent: { approvalPolicy: 'never' },
      })
      expect(warning?.message).toContain('approvalPolicy is "never"')
    })

    it('ignores readOnly and disabled tools', () => {
      expect(
        unapproved({
          tools: [
            { ...writable, readOnly: true },
            { ...writable, name: 'x', enabled: false },
          ],
        }),
      ).toEqual([])
    })
  })
})
