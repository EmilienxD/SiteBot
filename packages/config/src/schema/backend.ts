import { z } from 'zod'

/** docs/02-configuration.md §4. */
export const PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'azure',
  'bedrock',
  'vertex',
  'mistral',
  'groq',
  'openai-compatible',
  'ollama',
  'custom',
] as const

export type ProviderId = (typeof PROVIDERS)[number]

/**
 * The npm package each provider needs, and the environment variable it reads
 * by default. Used for the install hint in docs/04-providers-and-engine.md §2
 * and by `sitebot doctor`; kept here so the config layer is the single source
 * of truth for the provider list.
 */
export const PROVIDER_PACKAGES: Record<ProviderId, string | null> = {
  anthropic: '@ai-sdk/anthropic',
  openai: '@ai-sdk/openai',
  google: '@ai-sdk/google',
  azure: '@ai-sdk/azure',
  bedrock: '@ai-sdk/amazon-bedrock',
  vertex: '@ai-sdk/google-vertex',
  mistral: '@ai-sdk/mistral',
  groq: '@ai-sdk/groq',
  'openai-compatible': '@ai-sdk/openai-compatible',
  ollama: 'ollama-ai-provider',
  custom: null,
}

export const PROVIDER_ENV_VARS: Record<ProviderId, string | null> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  azure: 'AZURE_API_KEY',
  bedrock: null, // AWS credential chain
  vertex: null, // GCP application default credentials
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  'openai-compatible': null,
  ollama: null,
  custom: null,
}

/**
 * One model configuration. `fallback` entries use this same shape, which is why
 * it does not itself carry a `fallback` key — a fallback chain is a flat
 * ordered list, not a tree.
 */
const BackendEntryShape = {
  provider: z.enum(PROVIDERS).describe('Model provider.'),
  model: z
    .string()
    .min(1)
    .describe(
      'Model ID, passed to the provider verbatim. Never validated against a list, so new models work without upgrading this package.',
    ),
  apiKey: z
    .string()
    .optional()
    .describe(
      "API key. Use ${env.VAR}; defaults to the provider's conventional environment variable.",
    ),
  baseUrl: z
    .string()
    .optional()
    .describe('Override the provider endpoint — gateways, proxies, self-hosted.'),
  /** `provider: custom` only — `"./providers/x.ts#factory"`. */
  module: z
    .string()
    .optional()
    .describe(
      'For provider: custom — path to a module exporting a LanguageModel factory, e.g. ./providers/x.ts#factory',
    ),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().default(2048),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().default(60_000),
  maxRetries: z
    .number()
    .int()
    .min(0)
    .default(2)
    .describe('Retries within this provider before moving to the next fallback.'),
}

export const BackendEntrySchema = z.strictObject(BackendEntryShape)

export const ModelPricingSchema = z.strictObject({
  inputUsdPerMillion: z.number().nonnegative(),
  outputUsdPerMillion: z.number().nonnegative(),
})

export const BackendSchema = z
  .strictObject({
    ...BackendEntryShape,
    pricing: z
      .record(z.string(), ModelPricingSchema)
      .default({})
      .describe('Per-model USD prices keyed by provider:model; overrides the shipped table.'),
    fallback: z
      .array(BackendEntrySchema)
      .default([])
      .describe(
        'Ordered fallback chain, tried only before the first token is emitted (docs/04 §3).',
      ),
  })
  .describe('The model. docs/02-configuration.md §4.')

export type BackendEntry = z.output<typeof BackendEntrySchema>
export type Backend = z.output<typeof BackendSchema>
export type ModelPricing = z.output<typeof ModelPricingSchema>
