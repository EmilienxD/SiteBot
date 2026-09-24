import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BackendEntry } from '@sitebot/config'
import { describe, expect, it } from 'vitest'
import { moduleUrl, parseModuleSpec } from '../modules.js'
import { resolveModel } from './registry.js'

/**
 * docs/04 §2: every provider the schema accepts has an adapter. The cloud
 * providers and `custom` used to fail at runtime with "not available yet" —
 * config that validates must not be config that cannot run.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures')

const entry = (overrides: Partial<BackendEntry>): BackendEntry => ({
  provider: 'anthropic',
  model: 'm',
  maxOutputTokens: 2048,
  headers: {},
  timeoutMs: 60_000,
  maxRetries: 2,
  ...overrides,
})

describe('module paths', () => {
  it.each([
    ['./providers/x.ts', 'C:\\proj\\site', 'file:///C:/proj/site/providers/x.ts'],
    ['../shared/x.mjs', 'C:\\proj\\site', 'file:///C:/proj/shared/x.mjs'],
    ['./x.ts', '/srv/app', 'file:///srv/app/x.ts'],
    ['./my tools/x.ts', '/srv/app', 'file:///srv/app/my%20tools/x.ts'],
    ['D:\\abs\\x.ts', '/ignored', 'file:///D:/abs/x.ts'],
    ['file:///already/url.mjs', '/ignored', 'file:///already/url.mjs'],
  ])('%s from %s → %s', (path, baseDir, expected) => {
    expect(moduleUrl(path, baseDir)).toBe(expected)
  })

  it('splits an export name off the spec', () => {
    expect(parseModuleSpec('./x.ts#factory')).toEqual({ path: './x.ts', exportName: 'factory' })
    expect(parseModuleSpec('./x.ts')).toEqual({ path: './x.ts', exportName: 'default' })
  })
})

describe('provider: custom', () => {
  it('loads the factory relative to the config and returns its model', async () => {
    const resolved = await resolveModel(
      entry({ provider: 'custom', model: 'acme-1', module: './custom-provider.mjs#createModel' }),
      { baseDir: FIXTURES },
    )
    expect(resolved.id).toBe('custom:acme-1')
    expect((resolved.model as { modelId: string }).modelId).toBe('custom:acme-1')
  })

  it.each([
    [undefined, /requires backend\.module/],
    ['./missing.mjs#x', /could not be loaded/],
    ['./custom-provider.mjs#nope', /no export named "nope"/],
    ['./custom-provider.mjs#notAFunction', /is not a function/],
    ['./custom-provider.mjs#notAModel', /did not return a LanguageModel/],
  ])('%s fails with a fix, not a stack trace', async (module, message) => {
    await expect(
      resolveModel(entry({ provider: 'custom', ...(module ? { module } : {}) }), {
        baseDir: FIXTURES,
      }),
    ).rejects.toThrow(message)
  })
})

describe('cloud and local providers', () => {
  it.each([
    ['azure', '@ai-sdk/azure'],
    ['bedrock', '@ai-sdk/amazon-bedrock'],
    ['vertex', '@ai-sdk/google-vertex'],
  ] as const)(
    '%s has an adapter; without its package the error is the install hint',
    async (provider, pkg) => {
      const error = await resolveModel(entry({ provider })).catch((cause: unknown) => cause)
      expect(String((error as Error).message)).not.toMatch(/not available yet/)
      expect(String((error as Error).message)).toContain(`pnpm add ${pkg}`)
    },
  )

  it('names the compatible release line when a provider package implements the wrong model spec', async () => {
    const error = (await resolveModel(entry({ provider: 'ollama' }), {
      adapters: {
        ollama: async () => ({ specificationVersion: 'v4', doStream: () => undefined }) as never,
      },
    }).catch((cause: unknown) => cause as Error)) as Error
    expect(error.message).toContain('implements model spec v4')
    expect(error.message).toContain('pnpm add @ai-sdk/openai-compatible@^2')
  })

  it('pins install hints to the ai@6 release line of each package', async () => {
    const error = (await resolveModel(entry({ provider: 'bedrock' })).catch(
      (cause: unknown) => cause,
    )) as Error
    expect(error.message).toContain('pnpm add @ai-sdk/amazon-bedrock@^4')
  })
})
