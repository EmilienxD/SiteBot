import type { BackendEntry } from '@sitebot/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as OptionalImportModule from './optional-import.js'

type OptionalImport = typeof OptionalImportModule

/**
 * What each adapter hands its provider SDK. The SDK packages are optional
 * peers and not installed here, so the import is replaced with a recorder:
 * every `createX(settings)` call is captured and returns a model stand-in.
 */
const calls = vi.hoisted(() => [] as Array<{ factory: string; settings: Record<string, unknown> }>)

vi.mock('./optional-import.js', async (importOriginal) => {
  const original = await importOriginal<OptionalImport>()
  const recorder = new Proxy(
    {},
    {
      // `then` must stay undefined, or awaiting the module would treat the
      // recorder as a thenable and never settle.
      get: (_target, factory: string) =>
        factory === 'then'
          ? undefined
          : (settings: Record<string, unknown>) => {
              calls.push({ factory, settings })
              return (model: string) => ({ doStream: () => undefined, modelId: model })
            },
    },
  )
  return {
    ...original,
    importProviderPackage: async () => recorder,
    dynamicImport: async () => {
      throw new Error('not installed')
    },
  }
})

const { ADAPTERS } = await import('./adapters.js')

const entry = (overrides: Partial<BackendEntry>): BackendEntry => ({
  provider: 'anthropic',
  model: 'm',
  maxOutputTokens: 2048,
  headers: {},
  timeoutMs: 60_000,
  maxRetries: 2,
  ...overrides,
})

afterEach(() => {
  calls.length = 0
  vi.unstubAllEnvs()
})

describe('adapter settings', () => {
  it('ollama: OpenAI-compatible, local default endpoint, no key', async () => {
    await ADAPTERS.ollama(entry({ provider: 'ollama', model: 'qwen2.5:14b' }))
    expect(calls).toEqual([
      {
        factory: 'createOpenAICompatible',
        settings: { name: 'ollama', baseURL: 'http://localhost:11434/v1', includeUsage: true },
      },
    ])
  })

  it('ollama: backend.baseUrl overrides the default endpoint', async () => {
    await ADAPTERS.ollama(entry({ provider: 'ollama', baseUrl: 'http://gpu-box:11434/v1' }))
    expect(calls[0]?.settings.baseURL).toBe('http://gpu-box:11434/v1')
  })

  it('azure: key from AZURE_API_KEY; resource left to the SDK', async () => {
    vi.stubEnv('AZURE_API_KEY', 'az-key')
    await ADAPTERS.azure(entry({ provider: 'azure', model: 'my-deployment' }))
    expect(calls).toEqual([{ factory: 'createAzure', settings: { apiKey: 'az-key' } }])
  })

  it('bedrock: no static keys and no AWS SDK → the SDK reads the environment itself', async () => {
    await ADAPTERS.bedrock(entry({ provider: 'bedrock' }))
    expect(calls).toEqual([{ factory: 'createAmazonBedrock', settings: {} }])
  })

  it('vertex: application default credentials, nothing injected', async () => {
    await ADAPTERS.vertex(entry({ provider: 'vertex', headers: { 'x-team': 'web' } }))
    expect(calls).toEqual([{ factory: 'createVertex', settings: { headers: { 'x-team': 'web' } } }])
  })

  it('openai-compatible: requires a base URL and names itself', async () => {
    await expect(
      ADAPTERS['openai-compatible'](entry({ provider: 'openai-compatible' })),
    ).rejects.toThrow(/requires backend\.baseUrl/)
    await ADAPTERS['openai-compatible'](
      entry({ provider: 'openai-compatible', baseUrl: 'https://gw.example/v1', apiKey: 'k' }),
    )
    expect(calls.at(-1)).toEqual({
      factory: 'createOpenAICompatible',
      settings: { name: 'openai-compatible', apiKey: 'k', baseURL: 'https://gw.example/v1' },
    })
  })
})
