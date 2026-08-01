import { z } from 'zod'

/** The only `version` this package understands. */
export const CONFIG_SCHEMA_VERSION = 1 as const

/**
 * Tool naming rule — docs/05-tools.md §1. Providers are picky about tool names
 * and the model reads them, so the constraint is deliberately narrow.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export const ToolNameSchema = z
  .string()
  .regex(
    TOOL_NAME_PATTERN,
    'must be lowercase, start with a letter, and contain only letters, digits and underscores (max 64 chars)',
  )
  .describe('Unique tool name the model will call.')

/** `<count>/<window>` where window is `<n>[s|m|h|d]` — docs/02 §12. */
export const RATE_LIMIT_PATTERN = /^[1-9][0-9]*\/[1-9][0-9]*[smhd]$/

export const RateLimitRuleSchema = z
  .string()
  .regex(RATE_LIMIT_PATTERN, 'must look like "<count>/<window>", e.g. 30/5m or 100/1h')

/**
 * A JSON Schema (draft-07 subset) describing a tool's arguments.
 *
 * Deliberately loose past the three keys we rely on: the object is handed to
 * the provider more or less verbatim, so a developer using `pattern`, `enum` or
 * `minimum` should not have to wait for us to add it to a schema.
 */
export const JsonSchemaObjectSchema = z
  .looseObject({
    type: z.literal('object').default('object'),
    properties: z.record(z.string(), z.looseObject({})).default({}),
    required: z.array(z.string()).default([]),
  })
  .describe('JSON Schema (draft-07 subset) for the tool arguments.')

/**
 * A Zod schema supplied in place of JSON Schema. Only reachable from
 * `chatbot.config.ts`, and excluded from the published JSON Schema because it
 * has no declarative equivalent.
 */
export const ZodSchemaSchema = z.custom<z.ZodType>(
  (value) => typeof value === 'object' && value !== null && ('_zod' in value || '_def' in value),
  { error: 'expected a Zod schema' },
)

/** Any function, for `defineConfig`-only fields. */
export const FunctionSchema = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === 'function',
  { error: 'expected a function' },
)

/** A CSS selector list. Not parsed here; the widget and ingest own that. */
export const SelectorSchema = z.string().min(1)

/** A glob pattern such as `/docs/**`. */
export const GlobSchema = z.string().min(1)
