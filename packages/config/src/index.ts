/**
 * @sitebot/config — layer 1.
 *
 * The configuration schema, loader, and types. Zero workspace dependencies;
 * must stay importable from a browser bundle (the widget imports the
 * `UiConfig` type and the public-config validator).
 *
 * Implemented in Phase 1 — see docs/02-configuration.md and
 * docs/09-implementation-plan.md.
 */

/** The only currently supported value of the config file's `version` key. */
export const CONFIG_SCHEMA_VERSION = 1 as const

/** Config file basenames, in the resolution order of docs/02-configuration.md §1. */
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
