import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { minimalConfig } from '../test/helpers.js'
import { toPublicConfig, validateConfig } from './index.js'
import type { ResolvedConfig } from './index.js'

function resolve(
  config: Record<string, unknown>,
  env: Record<string, string> = {},
): ResolvedConfig {
  const result = validateConfig(config, { env })
  if (!result.ok) {
    throw new Error(`config did not validate: ${JSON.stringify(result.errors)}`)
  }
  return result.value
}

describe('toPublicConfig — the allowlist', () => {
  it('returns only the documented fields (docs/03 §6)', () => {
    const publicConfig = toPublicConfig(resolve(minimalConfig()))
    expect(Object.keys(publicConfig).sort()).toEqual(['capabilities', 'mode', 'name', 'ui'])
  })

  it('carries no server-side section at all', () => {
    const publicConfig = toPublicConfig(
      resolve({
        ...minimalConfig(),
        backend: {
          provider: 'anthropic',
          model: 'claude-opus-5',
          apiKey: 'sk-inline-not-from-env',
        },
      }),
    )
    const serialised = JSON.stringify(publicConfig)

    for (const section of [
      'backend',
      'prompt',
      'security',
      'storage',
      'telemetry',
      'tools',
      'knowledge',
      'siteContext',
      '$meta',
    ]) {
      expect(publicConfig).not.toHaveProperty(section)
    }
    // Even an inline (non-env) API key must not survive the allowlist.
    expect(serialised).not.toContain('sk-inline-not-from-env')
  })

  it('reports capabilities from the resolved config', () => {
    const publicConfig = toPublicConfig(
      resolve({
        ...minimalConfig(),
        security: { auth: { mode: 'required', jwt: { secret: 'x' } } },
        ui: { behaviour: { streaming: false, allowFileUpload: true } },
        tools: [
          {
            name: 'highlight_section',
            description: 'Highlight part of the page.',
            readOnly: true,
            executor: { type: 'client', id: 'highlight' },
          },
          {
            name: 'get_cart',
            description: 'Read the shopping cart.',
            readOnly: true,
            executor: { type: 'client', id: 'get_cart' },
          },
          {
            name: 'search_docs',
            description: 'Search the docs.',
            readOnly: true,
            executor: { type: 'builtin', id: 'search_knowledge_base' },
          },
        ],
      }),
    )

    expect(publicConfig.capabilities).toEqual({
      streaming: false,
      fileUpload: true,
      // Only client tools; the server-side ones are none of the browser's
      // business, and this list is the authoritative execution allowlist.
      clientTools: ['highlight_section', 'get_cart'],
      authMode: 'required',
    })
  })

  it('omits a disabled client tool from the allowlist', () => {
    const publicConfig = toPublicConfig(
      resolve({
        ...minimalConfig(),
        tools: [
          {
            name: 'highlight_section',
            description: 'Highlight part of the page.',
            readOnly: true,
            enabled: false,
            executor: { type: 'client', id: 'highlight' },
          },
        ],
      }),
    )
    expect(publicConfig.capabilities.clientTools).toEqual([])
  })

  it('adds the package version only when given one', () => {
    const config = resolve(minimalConfig())
    expect(toPublicConfig(config)).not.toHaveProperty('version')
    expect(toPublicConfig(config, { version: '1.2.3' }).version).toBe('1.2.3')
  })
})

describe('toPublicConfig — mechanical env exclusion (docs/08 §2)', () => {
  it('drops an env-sourced name rather than masking it', () => {
    const publicConfig = toPublicConfig(
      resolve(
        { ...minimalConfig(), name: '${env.SITE_NAME}' },
        {
          SITE_NAME: 'Acme Assistant',
        },
      ),
    )
    expect(publicConfig).not.toHaveProperty('name')
    expect(JSON.stringify(publicConfig)).not.toContain('Acme Assistant')
  })

  it('drops the derived panel title too', () => {
    // ui.panel.title defaults to `name`, so an env-sourced name would otherwise
    // launder itself into the public config through a field nobody looked at.
    const publicConfig = toPublicConfig(
      resolve(
        { ...minimalConfig(), name: '${env.SITE_NAME}' },
        {
          SITE_NAME: 'Acme Assistant',
        },
      ),
    )
    expect(publicConfig.ui.panel).not.toHaveProperty('title')
  })

  it('keeps an explicit panel title that did not come from the environment', () => {
    const publicConfig = toPublicConfig(
      resolve(
        {
          ...minimalConfig(),
          name: '${env.SITE_NAME}',
          ui: { panel: { title: 'Acme' } },
        },
        { SITE_NAME: 'Internal Name' },
      ),
    )
    expect(publicConfig.ui.panel.title).toBe('Acme')
  })

  it('keeps a name that was written inline', () => {
    expect(toPublicConfig(resolve(minimalConfig())).name).toBe('Acme')
  })
})

/**
 * Where a `${env.*}` may legally appear. Deliberately spans both allowlisted
 * and non-allowlisted fields — the guarantee is "no env-sourced value reaches
 * the browser", not "the allowlist happens to be right".
 */
const ENV_TARGETS: {
  label: string
  set: (config: Record<string, any>, value: string) => void
}[] = [
  { label: 'name', set: (c, v) => void (c['name'] = v) },
  { label: 'backend.apiKey', set: (c, v) => void (c['backend'].apiKey = v) },
  { label: 'backend.baseUrl', set: (c, v) => void (c['backend'].baseUrl = v) },
  {
    label: 'siteContext.company',
    set: (c, v) => void (c['siteContext'] = { ...c['siteContext'], company: v }),
  },
  {
    label: 'prompt.variables.tier',
    set: (c, v) => void (c['prompt'].variables = { tier: v }),
  },
  {
    label: 'security.publicKey',
    set: (c, v) => void (c['security'] = { ...c['security'], publicKey: v }),
  },
  {
    label: 'security.auth.jwt.secret',
    set: (c, v) =>
      void (c['security'] = {
        ...c['security'],
        auth: { mode: 'optional', jwt: { secret: v } },
      }),
  },
  {
    label: 'telemetry.events.webhook',
    set: (c, v) => void (c['telemetry'] = { events: { webhook: v } }),
  },
]

describe('property: no env-sourced value survives toPublicConfig', () => {
  it('holds for every combination of env-sourced fields', () => {
    fc.assert(
      fc.property(fc.subarray(ENV_TARGETS, { minLength: 1 }), fc.nat(), (targets, token) => {
        const env: Record<string, string> = {}
        const config = minimalConfig()

        targets.forEach((target, index) => {
          const variable = `SECRET_${index}`
          // A distinctive value so a match in the output can only mean the
          // env value leaked, never a coincidental substring.
          env[variable] = `sk-leak-${token}-${index}`
          target.set(config, `\${env.${variable}}`)
        })

        const result = validateConfig(config, { env })
        if (!result.ok) {
          throw new Error(`generated config did not validate: ${JSON.stringify(result.errors)}`)
        }

        const serialised = JSON.stringify(toPublicConfig(result.value, { version: '1.0.0' }))
        for (const secret of Object.values(env)) {
          expect(serialised).not.toContain(secret)
        }
      }),
      { numRuns: 250 },
    )
  })
})
