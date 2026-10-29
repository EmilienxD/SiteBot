import { embedMany, type EmbeddingModel } from 'ai'
import type { Knowledge } from '@sitebot/config'
import { providerInstallSpec } from '@sitebot/config'
import { importOptional, isModuleNotFound, readEnv } from '@sitebot/core'

/** The embedding block from the resolved config, non-optional. */
export type EmbeddingConfigLike = NonNullable<Knowledge['embedding']>

/** Say "install X" with the right package for the provider. */
function hint(provider: string, specifier: string): Error {
  return new Error(
    `Embedding provider "${provider}" requires an optional dependency.\n` +
      `  Install it:  pnpm add ${providerInstallSpec(specifier)}`,
  )
}

/**
 * Embedding provider registry — docs/06-knowledge.md §3.5.
 *
 * Same lazy-registry pattern as the language-model providers
 * (`providers/adapters.ts` in core): the SDK is an optional peer imported
 * behind a variable so the ingest package typechecks without any of them
 * installed, and a missing package fails with the install command.
 *
 * Token-cost figures power `--dry-run`'s estimate and the ingest summary. They
 * are US dollars per million tokens, last reviewed against provider pricing
 * pages at implementation time; `sitebot validate` warns when a model is
 * unknown so the estimate is understood to be a floor, not a quote.
 */

export interface EmbeddingAdapter {
  /** Builds the SDK model. Called once per ingest run. */
  create(config: EmbeddingConfigLike): EmbeddingModel
  /** USD per 1M input tokens, for cost estimates. */
  dollarsPerMillionTokens(model: string): number | undefined
}

export type EmbeddingConfig = EmbeddingConfigLike

const PACKAGES: Record<EmbeddingConfig['provider'], string | null> = {
  openai: '@ai-sdk/openai',
  google: '@ai-sdk/google',
  mistral: '@ai-sdk/mistral',
  cohere: 'cohere-ai', // official SDK; @ai-sdk/cohere is community-maintained
  voyage: 'voyageai',
  ollama: null, // plain HTTP, no SDK
  'openai-compatible': '@ai-sdk/openai-compatible',
}

const PRICING: Record<string, number> = {
  // USD per 1M tokens — unknown models return undefined.
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'text-embedding-004': 0.0, // free tier
  'mistral-embed': 0.1,
  'embed-v4.0': 0.12,
  'voyage-3': 0.06,
  'nomic-embed-text': 0,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loaded = Record<string, any>

async function loadPackage(provider: EmbeddingConfig['provider']): Promise<Loaded | null> {
  const specifier = PACKAGES[provider]
  if (specifier === null) return null
  try {
    // Resolved from the project too, not only from this package — see
    // importOptional in @sitebot/core.
    return await importOptional(specifier)
  } catch (error) {
    if (isModuleNotFound(error, specifier)) throw hint(provider, specifier)
    throw error
  }
}

export async function createEmbeddingModel(
  config: EmbeddingConfig,
  purpose: 'document' | 'query' = 'document',
): Promise<{ model: EmbeddingModel; modelId: string; provider: EmbeddingConfig['provider'] }> {
  switch (config.provider) {
    case 'openai': {
      const sdk = await loadPackage('openai')
      const factory = sdk?.['createOpenAI']
      if (typeof factory !== 'function') throw missingFactory('@ai-sdk/openai', 'createOpenAI')
      const openai = factory({
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
      })
      const model = openai.embedding(config.model, {
        ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
      }) as EmbeddingModel
      return { model, modelId: config.model, provider: 'openai' }
    }
    case 'google': {
      const sdk = await loadPackage('google')
      const factory = sdk?.['createGoogleGenerativeAI']
      if (typeof factory !== 'function') {
        throw missingFactory('@ai-sdk/google', 'createGoogleGenerativeAI')
      }
      const google = factory({
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
      })
      const model = google.textEmbedding(config.model) as EmbeddingModel
      return { model, modelId: config.model, provider: 'google' }
    }
    case 'mistral': {
      const sdk = await loadPackage('mistral')
      const factory = sdk?.['createMistral']
      if (typeof factory !== 'function') throw missingFactory('@ai-sdk/mistral', 'createMistral')
      const mistral = factory({
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
      })
      const model = mistral.embedding(config.model) as EmbeddingModel
      return { model, modelId: config.model, provider: 'mistral' }
    }
    case 'openai-compatible': {
      const sdk = await loadPackage('openai-compatible')
      const factory = sdk?.['createOpenAICompatible']
      if (typeof factory !== 'function') {
        throw missingFactory('@ai-sdk/openai-compatible', 'createOpenAICompatible')
      }
      if (config.baseUrl === undefined) {
        throw new Error(
          'embedding.provider "openai-compatible" requires baseUrl — there is no default endpoint.',
        )
      }
      const compatible = factory({
        baseURL: config.baseUrl,
        name: 'openai-compatible',
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      })
      const model = compatible.embeddingModel(config.model) as EmbeddingModel
      return { model, modelId: config.model, provider: 'openai-compatible' }
    }
    case 'cohere':
    case 'voyage': {
      // No maintained @ai-sdk adapter: both ship client SDKs with an embed
      // endpoint, so the adapter below is a thin EmbeddingModel over fetch.
      return createHttpEmbeddingModel(config, httpSpec(config.provider, purpose))
    }
    case 'ollama': {
      // Local, zero-cost, no key. The native `/api/embed` endpoint accepts a
      // batch and returns embeddings; the base URL defaults to the stock one.
      return createHttpEmbeddingModel(config, {
        url: `${config.baseUrl ?? 'http://127.0.0.1:11434'}/api/embed`,
        headers: {},
        body: (model, texts) => ({ model, input: texts }),
        pluck: (body) => (body as { embeddings: number[][] }).embeddings,
      })
    }
  }
}

function missingFactory(pkg: string, name: string): Error {
  return new Error(
    `${pkg} was found but does not export ${name} — the installed version is too old.`,
  )
}

interface HttpSpec {
  url: string
  headers: Record<string, string>
  body(model: string, texts: string[]): Record<string, unknown>
  pluck(body: unknown): number[][]
}

function httpSpec(
  provider: 'cohere' | 'voyage',
  purpose: 'document' | 'query',
): (config: EmbeddingConfig) => HttpSpec {
  if (provider === 'cohere') {
    return (config) => ({
      url: `${config.baseUrl ?? 'https://api.cohere.com'}/v2/embed`,
      headers: {
        authorization: `Bearer ${config.apiKey ?? readEnv('COHERE_API_KEY') ?? ''}`,
        'content-type': 'application/json',
      },
      body: (model, texts) => ({
        model,
        texts,
        input_type: purpose === 'query' ? 'search_query' : 'search_document',
        embedding_types: ['float'],
        ...(config.dimensions === undefined ? {} : { output_dimension: config.dimensions }),
      }),
      pluck: (body) => (body as { embeddings: { float: number[][] } }).embeddings.float,
    })
  }
  return (config) => ({
    url: `${config.baseUrl ?? 'https://api.voyageai.com'}/v1/embeddings`,
    headers: {
      authorization: `Bearer ${config.apiKey ?? readEnv('VOYAGE_API_KEY') ?? ''}`,
      'content-type': 'application/json',
    },
    body: (model, texts) => ({
      model,
      input: texts,
      input_type: purpose,
      ...(config.dimensions === undefined ? {} : { output_dimension: config.dimensions }),
    }),
    pluck: (body) => (body as { data: { embedding: number[] }[] }).data.map((d) => d.embedding),
  })
}

function createHttpEmbeddingModel(
  config: EmbeddingConfig,
  spec: HttpSpec | ((config: EmbeddingConfig) => HttpSpec),
): { model: EmbeddingModel; modelId: string; provider: EmbeddingConfig['provider'] } {
  const resolved = typeof spec === 'function' ? spec(config) : spec
  const model: EmbeddingModel = {
    specificationVersion: 'v3',
    provider: `sitebot.${config.provider}`,
    modelId: config.model,
    maxEmbeddingsPerCall: config.batchSize,
    supportsParallelCalls: false,
    async doEmbed(options: {
      values: string[]
      abortSignal?: AbortSignal
      headers?: Record<string, string | undefined>
    }) {
      const response = await fetch(resolved.url, {
        method: 'POST',
        headers: resolved.headers,
        body: JSON.stringify(resolved.body(config.model, options.values)),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(
          `${config.provider} embedding request failed (${response.status}): ${body.slice(0, 200)}`,
        )
      }
      const body = (await response.json()) as unknown
      const embeddings = resolved.pluck(body)
      return { embeddings, warnings: [] }
    },
  } as unknown as EmbeddingModel
  return { model, modelId: config.model, provider: config.provider }
}

/** Batched embedding with bounded concurrency and retry. docs/06 §3.5. */
export async function embedChunks(
  model: EmbeddingModel,
  texts: string[],
  options: { batchSize?: number; concurrency?: number } = {},
): Promise<{ embeddings: number[][]; tokens: number }> {
  const batchSize = options.batchSize ?? 96
  const concurrency = options.concurrency ?? 4
  const batches: string[][] = []
  for (let index = 0; index < texts.length; index += batchSize) {
    batches.push(texts.slice(index, index + batchSize))
  }

  const embeddings: number[][] = new Array(texts.length)
  let tokens = 0
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (cursor < batches.length) {
        const batchIndex = cursor++
        const batch = batches[batchIndex]!
        const result = await withRetry(() => embedMany({ model, values: batch, maxRetries: 0 }))
        for (let offset = 0; offset < batch.length; offset++) {
          embeddings[batchIndex * batchSize + offset] = result.embeddings[offset]!
        }
        tokens += embeddingTokens(result.usage?.tokens, batch)
      }
    }),
  )
  return { embeddings, tokens }
}

/** The AI SDK uses NaN when an embedding provider omits usage. */
export function embeddingTokens(reported: number | undefined, texts: readonly string[]): number {
  return reported !== undefined && Number.isFinite(reported) && reported >= 0
    ? reported
    : texts.reduce((total, text) => total + Math.ceil(text.length / 4), 0)
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let error: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (caught) {
      error = caught
      const retryable =
        typeof caught === 'object' && caught !== null && 'statusCode' in caught
          ? [408, 409, 429].includes(Number((caught as { statusCode: unknown }).statusCode)) ||
            Number((caught as { statusCode: unknown }).statusCode) >= 500
          : true // network failures carry no status; treat them as retryable
      if (!retryable || attempt === attempts - 1) throw caught
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
  throw error
}

/** USD per 1M tokens for the model, or undefined when unknown. */
export function dollarsPerMillionTokens(model: string): number | undefined {
  return PRICING[model]
}
