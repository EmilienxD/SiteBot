/**
 * `@sitebot/config` — layer 1. Schema, validation and types.
 *
 * This entry must stay importable from a browser bundle: no `node:*`, no
 * filesystem, no `process` beyond an optional read off `globalThis`. The
 * loader, which needs all three, lives behind `@sitebot/config/node`.
 *
 * docs/02-configuration.md is the reference for every field; docs/01-architecture.md
 * §2 defines the API surface.
 */

export * from './schema/index.js'

export { defineConfig } from './define.js'
export { validateConfig } from './validate.js'
export type { ResolvedConfig, ValidateOptions } from './validate.js'
export { toPublicConfig } from './public.js'
export type { PublicCapabilities, PublicConfig, PublicConfigOptions } from './public.js'
export { emitJsonSchema, JSON_SCHEMA_ID, JSON_SCHEMA_PATH } from './json-schema.js'
export type { JsonSchema } from './json-schema.js'
export { checkCrossFields } from './cross-field.js'
export type { CrossFieldContext, CrossFieldResult } from './cross-field.js'
export { mergeConfigChain, mergeConfigs } from './merge.js'
export { containsEnvPlaceholder, interpolateEnv, isEnvSourced, isExemptFromEnv } from './env.js'
export type { InterpolateOptions, InterpolateResult } from './env.js'
export {
  ConfigLoadError,
  ConfigValidationError,
  didYouMean,
  formatConfigError,
  formatConfigErrors,
  formatConfigWarning,
  formatPath,
  levenshtein,
} from './errors.js'
export type { BuildTarget, ConfigError, ConfigWarning, ResolutionMeta, Result } from './types.js'

/**
 * Config file basenames in the resolution order of docs/02-configuration.md §1.
 * Lives in the browser-safe entry so tooling can reason about the search order
 * without pulling in the loader.
 */
export const CONFIG_FILENAMES = [
  'chatbot.config.ts',
  'chatbot.config.mts',
  'chatbot.config.js',
  'chatbot.config.mjs',
  'chatbot.config.yaml',
  'chatbot.config.yml',
  'chatbot.config.json',
  'chatbot.config.toml',
] as const

export type ConfigFilename = (typeof CONFIG_FILENAMES)[number]

/** Last resort in the search order: a `sitebot` key in `package.json`. */
export const PACKAGE_JSON_KEY = 'sitebot'
