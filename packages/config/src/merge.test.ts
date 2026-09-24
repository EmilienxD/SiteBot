import { describe, expect, it } from 'vitest'
import { mergeConfigChain, mergeConfigs } from './index.js'

/** `extends` merge semantics — docs/02-configuration.md §1. */

describe('scalars and objects deep-merge, the overriding file wins', () => {
  it('merges nested objects rather than replacing them', () => {
    const merged = mergeConfigs(
      {
        backend: { provider: 'anthropic', model: 'claude-opus-5', maxRetries: 2 },
      },
      { backend: { model: 'claude-sonnet-5' } },
    )
    expect(merged).toEqual({
      backend: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        maxRetries: 2,
      },
    })
  })

  it('leaves the base alone where the override says nothing', () => {
    const merged = mergeConfigs({ name: 'Acme', mode: 'chat' }, { mode: 'agent' })
    expect(merged).toEqual({ name: 'Acme', mode: 'agent' })
  })

  it('replaces an object whose `type` changes instead of mixing two variants', () => {
    const base = { storage: { type: 'sqlite', path: './sessions.db', ttlSeconds: 60 } }
    expect(mergeConfigs(base, { storage: { type: 'memory' } })).toEqual({
      storage: { type: 'memory' },
    })
    // Same variant: still a deep merge.
    expect(mergeConfigs(base, { storage: { type: 'sqlite', ttlSeconds: 5 } })).toEqual({
      storage: { type: 'sqlite', path: './sessions.db', ttlSeconds: 5 },
    })
  })

  it('does not mutate either input', () => {
    const base = { ui: { theme: { primary: '#000' } } }
    const override = { ui: { theme: { primary: '#fff' } } }
    mergeConfigs(base, override)
    expect(base.ui.theme.primary).toBe('#000')
    expect(override.ui.theme.primary).toBe('#fff')
  })
})

describe('arrays of primitives are replaced', () => {
  it('replaces allowedOrigins wholesale', () => {
    const merged = mergeConfigs(
      { security: { allowedOrigins: ['https://a.com', 'https://b.com'] } },
      { security: { allowedOrigins: ['https://c.com'] } },
    )
    expect(merged).toEqual({
      security: { allowedOrigins: ['https://c.com'] },
    })
  })

  it('replaces suggestions rather than growing them', () => {
    const merged = mergeConfigs(
      { ui: { messages: { suggestions: [{ label: 'a' }, { label: 'b' }] } } },
      { ui: { messages: { suggestions: [{ label: 'c' }] } } },
    ) as { ui: { messages: { suggestions: unknown[] } } }
    expect(merged.ui.messages.suggestions).toHaveLength(1)
  })
})

describe('tools[] merge by name', () => {
  it('replaces a same-named tool outright', () => {
    const merged = mergeConfigs(
      {
        tools: [
          {
            name: 'quote',
            description: 'from yaml',
            executor: { type: 'http', url: 'https://a.com' },
          },
        ],
      },
      { tools: [{ name: 'quote', description: 'from ts', execute: 'fn' }] },
    ) as { tools: Record<string, unknown>[] }

    expect(merged.tools).toHaveLength(1)
    expect(merged.tools[0]).toEqual({
      name: 'quote',
      description: 'from ts',
      execute: 'fn',
    })
    // Replacement, not deep merge: a half-YAML http executor blended into a TS
    // handler is not a thing anyone wants.
    expect(merged.tools[0]).not.toHaveProperty('executor')
  })

  it('appends a differently-named tool and keeps base order', () => {
    const merged = mergeConfigs(
      { tools: [{ name: 'a' }, { name: 'b' }] },
      { tools: [{ name: 'b', updated: true }, { name: 'c' }] },
    ) as { tools: Record<string, unknown>[] }

    expect(merged.tools.map((tool) => tool['name'])).toEqual(['a', 'b', 'c'])
    expect(merged.tools[1]).toEqual({ name: 'b', updated: true })
  })

  it('matches bulk MCP imports on their id', () => {
    const merged = mergeConfigs(
      { tools: [{ from: 'mcp', id: 'acme', allow: ['a'] }] },
      { tools: [{ from: 'mcp', id: 'acme', allow: ['a', 'b'] }] },
    ) as { tools: Record<string, unknown>[] }

    expect(merged.tools).toHaveLength(1)
    expect(merged.tools[0]?.['allow']).toEqual(['a', 'b'])
  })

  it('appends entries that have nothing to match on', () => {
    const merged = mergeConfigs(
      { tools: [{ name: 'a' }] },
      { tools: [{ description: 'nameless' }] },
    ) as { tools: unknown[] }
    expect(merged.tools).toHaveLength(2)
  })
})

describe('knowledge.sources[] concatenate', () => {
  it('applies both sides', () => {
    const merged = mergeConfigs(
      { knowledge: { sources: [{ type: 'sitemap', url: 'https://a.com' }] } },
      { knowledge: { sources: [{ type: 'text', id: 'faq', content: 'x' }] } },
    ) as { knowledge: { sources: unknown[] } }

    expect(merged.knowledge.sources).toHaveLength(2)
  })

  it('leaves sibling knowledge keys deep-merged', () => {
    const merged = mergeConfigs(
      { knowledge: { sources: [{ type: 'text' }], chunk: { maxTokens: 512 } } },
      { knowledge: { sources: [], chunk: { overlapTokens: 32 } } },
    )
    expect(merged).toEqual({
      knowledge: {
        sources: [{ type: 'text' }],
        chunk: { maxTokens: 512, overlapTokens: 32 },
      },
    })
  })
})

describe('mergeConfigChain', () => {
  it('applies left to right, later wins', () => {
    const merged = mergeConfigChain([{ name: 'a', mode: 'chat' }, { name: 'b' }, { mode: 'agent' }])
    expect(merged).toEqual({ name: 'b', mode: 'agent' })
  })

  it('accumulates tools across the whole chain', () => {
    const merged = mergeConfigChain([
      { tools: [{ name: 'a' }] },
      { tools: [{ name: 'b' }] },
      { tools: [{ name: 'a', overridden: true }] },
    ]) as { tools: Record<string, unknown>[] }

    expect(merged.tools.map((tool) => tool['name'])).toEqual(['a', 'b'])
    expect(merged.tools[0]?.['overridden']).toBe(true)
  })
})
