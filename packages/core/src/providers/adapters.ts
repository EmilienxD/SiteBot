import { type ProviderId } from '@sitebot/config'
import type { BackendEntry } from '@sitebot/config'
import type { LanguageModel } from 'ai'
import { EngineError } from '../stream/errors.js'
import { importProviderPackage, readEnv } from './optional-import.js'

/**
 * One adapter per provider — docs/04-providers-and-engine.md §2.
 *
 * They live in one module rather than one file each because laziness comes
 * from {@link importProviderPackage}, not from the file boundary: a project
 * using Anthropic still never loads `@ai-sdk/openai`, because nothing here
 * imports a provider SDK until its adapter runs.
 *
 * Model IDs are pass-through. We deliberately keep no allowlist of model names,
 * so a model released after this package was published works immediately.
 */

export type ProviderFactory = (cfg: BackendEntry) => Promise<LanguageModel>

/**
 * The common shape: a `createX({ apiKey, baseURL, headers })` factory that
 * returns a callable provider. Every hosted provider we support in Phase 2
 * fits it; the ones that do not (bedrock, vertex, azure) need cloud credential
 * plumbing and land with Phase 8's deployment work.
 */
function standardAdapter(
  provider: ProviderId,
  factoryName: string,
  options: { envVar?: string | null; requiresBaseUrl?: boolean } = {},
): ProviderFactory {
  return async (cfg) => {
    const mod = await importProviderPackage(provider)
    const create = mod[factoryName]
    if (typeof create !== 'function') {
      throw new EngineError('not_ready', {
        message: `The installed package for provider "${provider}" does not export ${factoryName}().`,
        detail: `expected ${factoryName} in the provider package`,
      })
    }

    const apiKey =
      cfg.apiKey ?? (options.envVar == null ? undefined : readEnv(options.envVar)) ?? undefined

    if (options.requiresBaseUrl === true && cfg.baseUrl === undefined) {
      throw new EngineError('not_ready', {
        message: `Provider "${provider}" requires backend.baseUrl.`,
      })
    }

    const settings: Record<string, unknown> = {}
    if (apiKey !== undefined) settings.apiKey = apiKey
    if (cfg.baseUrl !== undefined) settings.baseURL = cfg.baseUrl
    if (Object.keys(cfg.headers).length > 0) settings.headers = cfg.headers
    // `openai-compatible` requires a name for its telemetry/provider id.
    if (provider === 'openai-compatible') settings.name = 'openai-compatible'

    const instance = create(settings) as (model: string) => LanguageModel
    return instance(cfg.model)
  }
}

/** Providers whose credentials do not fit the `apiKey` shape. */
function unsupported(provider: ProviderId, why: string): ProviderFactory {
  return async () => {
    throw new EngineError('not_ready', {
      message: `Provider "${provider}" is not available yet: ${why}`,
      detail: `provider ${provider} has no adapter in this build`,
    })
  }
}

export const ADAPTERS: Record<ProviderId, ProviderFactory> = {
  anthropic: standardAdapter('anthropic', 'createAnthropic', { envVar: 'ANTHROPIC_API_KEY' }),
  openai: standardAdapter('openai', 'createOpenAI', { envVar: 'OPENAI_API_KEY' }),
  google: standardAdapter('google', 'createGoogleGenerativeAI', {
    envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
  }),
  mistral: standardAdapter('mistral', 'createMistral', { envVar: 'MISTRAL_API_KEY' }),
  groq: standardAdapter('groq', 'createGroq', { envVar: 'GROQ_API_KEY' }),
  'openai-compatible': standardAdapter('openai-compatible', 'createOpenAICompatible', {
    envVar: null,
    requiresBaseUrl: true,
  }),
  // Ollama is local: no key, and a conventional default endpoint.
  ollama: standardAdapter('ollama', 'createOllama', { envVar: null }),

  azure: unsupported('azure', 'Azure resource-name credentials arrive with Phase 8.'),
  bedrock: unsupported('bedrock', 'the AWS credential chain arrives with Phase 8.'),
  vertex: unsupported('vertex', 'GCP application default credentials arrive with Phase 8.'),
  // `provider: custom` loads a module from disk, which the edge-safe entry
  // cannot do. It is wired up by the Node loader alongside `module` tool
  // executors in Phase 5.
  custom: unsupported('custom', 'module loading arrives with Phase 5.'),
}
