import { z } from 'zod'
import { ConfigSchema } from './schema/config.js'

export type JsonSchema = z.core.JSONSchema.BaseSchema

/** Where the generated file is published, and what `$schema` comments point at. */
export const JSON_SCHEMA_PATH = 'schema/chatbot.schema.json'
export const JSON_SCHEMA_ID = 'https://unpkg.com/@sitebot/config/schema/chatbot.schema.json'

/**
 * The published JSON Schema — docs/02-configuration.md §14.
 *
 * Generated from the Zod schema at build time so the two cannot drift. Users
 * add one line to their YAML and get autocomplete and inline validation:
 *
 *   # yaml-language-server: $schema=./node_modules/@sitebot/config/schema/chatbot.schema.json
 *
 * `io: 'input'` matters: it emits the schema of what a developer *writes*, so
 * every field carrying a default is optional. Emitting the output schema would
 * mark two dozen defaulted keys as required and light the whole file up red.
 */
export function emitJsonSchema(): JsonSchema {
  const schema = z.toJSONSchema(ConfigSchema, {
    target: 'draft-7',
    io: 'input',
    // Zod schemas and inline handlers live on the code-only config type and are
    // not part of ConfigSchema, so nothing here should be unrepresentable.
    // Throwing keeps it that way rather than silently emitting `{}`.
    unrepresentable: 'throw',
  })

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: JSON_SCHEMA_ID,
    title: 'SiteBot configuration',
    ...schema,
  }
}
