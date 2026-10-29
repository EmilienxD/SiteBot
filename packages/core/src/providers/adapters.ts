import { type ProviderId } from '@sitebot/config'
import type { BackendEntry } from '@sitebot/config'
import type { LanguageModel } from 'ai'
import { EngineError } from '../stream/errors.js'
import { loadModuleExport, parseModuleSpec } from '../modules.js'
import { importOptional, importProviderPackage, readEnv } from './optional-import.js'

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

export interface ProviderContext {
  /** The config file's directory — where `provider: custom` modules resolve from. */
  baseDir?: string | null | undefined
}

export type ProviderFactory = (
  cfg: BackendEntry,
  context?: ProviderContext,
) => Promise<LanguageModel>

/**
 * The common shape: a `createX({ apiKey, baseURL, headers })` factory that
 * returns a callable provider. The cloud providers fit it too — their SDKs
 * read the rest of their credentials from the environment (Azure's resource
 * name, Vertex's project and application default credentials, AWS's region),
 * so `extra` only has to add what the environment cannot express.
 */
function standardAdapter(
  provider: ProviderId,
  factoryName: string,
  options: {
    envVar?: string | null
    requiresBaseUrl?: boolean
    defaults?: Record<string, unknown>
    extra?: (cfg: BackendEntry) => Promise<Record<string, unknown>>
  } = {},
): ProviderFactory {
  return async (cfg, context) => {
    const mod = await importProviderPackage(provider, { baseDir: context?.baseDir })
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

    const settings: Record<string, unknown> = { ...options.defaults }
    if (apiKey !== undefined) settings.apiKey = apiKey
    if (cfg.baseUrl !== undefined) settings.baseURL = cfg.baseUrl
    if (Object.keys(cfg.headers).length > 0) settings.headers = cfg.headers
    Object.assign(settings, await options.extra?.(cfg))

    const instance = create(settings) as (model: string) => LanguageModel
    return instance(cfg.model)
  }
}

/**
 * Bedrock reads `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from the
 * environment by itself. Everything else in the AWS credential chain — SSO,
 * instance roles, `~/.aws/credentials` — needs the AWS SDK's provider chain,
 * which is used when it is installed and static keys are absent.
 */
async function bedrockCredentials(): Promise<Record<string, unknown>> {
  if (
    readEnv('AWS_ACCESS_KEY_ID') !== undefined ||
    readEnv('AWS_BEARER_TOKEN_BEDROCK') !== undefined
  )
    return {}
  try {
    const chain = await importOptional('@aws-sdk/credential-providers')
    if (typeof chain.fromNodeProviderChain === 'function')
      return { credentialProvider: chain.fromNodeProviderChain() }
  } catch {
    /* not installed: the provider reports missing credentials itself */
  }
  return {}
}

/**
 * `provider: custom` — docs/04 §2. `backend.module` names a module exporting a
 * factory, `"./providers/acme.ts#createModel"`; the factory receives the
 * backend entry and returns an AI SDK `LanguageModel`.
 */
const customAdapter: ProviderFactory = async (cfg, context) => {
  if (cfg.module === undefined) {
    throw new EngineError('not_ready', {
      message: 'provider: custom requires backend.module, e.g. "./providers/acme.ts#createModel".',
    })
  }
  const { path, exportName } = parseModuleSpec(cfg.module)
  const factory = await loadModuleExport(path, exportName, {
    baseDir: context?.baseDir,
    kind: 'Custom provider',
  })
  if (typeof factory !== 'function') {
    throw new EngineError('not_ready', {
      message: `Custom provider export "${exportName}" is not a function.`,
    })
  }
  const model = (await (factory as (cfg: BackendEntry) => unknown)(cfg)) as LanguageModel
  if (typeof model !== 'object' || model === null || !('doStream' in model)) {
    throw new EngineError('not_ready', {
      message: `Custom provider "${cfg.module}" did not return a LanguageModel.`,
    })
  }
  return model
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
    // The package requires a name for its telemetry/provider id.
    defaults: { name: 'openai-compatible' },
  }),
  // Ollama is local: no key, its OpenAI-compatible endpoint on the default
  // port, overridable with backend.baseUrl.
  ollama: standardAdapter('ollama', 'createOpenAICompatible', {
    envVar: null,
    // Ollama only reports streamed token counts when explicitly requested.
    defaults: { name: 'ollama', baseURL: 'http://localhost:11434/v1', includeUsage: true },
  }),
  // The model id is the Azure *deployment* name; the resource comes from
  // AZURE_RESOURCE_NAME unless backend.baseUrl points at the endpoint.
  azure: standardAdapter('azure', 'createAzure', { envVar: 'AZURE_API_KEY' }),
  bedrock: standardAdapter('bedrock', 'createAmazonBedrock', {
    envVar: null,
    extra: bedrockCredentials,
  }),
  // Application default credentials plus GOOGLE_VERTEX_PROJECT/LOCATION.
  vertex: standardAdapter('vertex', 'createVertex', { envVar: null }),
  custom: customAdapter,
}
