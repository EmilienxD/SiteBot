import { z } from 'zod'
import { AgentSchema, MODES } from './agent.js'
import { BackendSchema } from './backend.js'
import { KnowledgeSchema } from './knowledge.js'
import { CONFIG_SCHEMA_VERSION, FunctionSchema } from './primitives.js'
import { PromptSchema } from './prompt.js'
import { SecuritySchema } from './security.js'
import { SiteContextSchema } from './site-context.js'
import { StorageSchema } from './storage.js'
import { TelemetrySchema } from './telemetry.js'
import { DeclarativeToolEntrySchema, ToolEntrySchema } from './tools.js'
import { UiSchema } from './ui.js'

/** Lifecycle hooks — docs/04-providers-and-engine.md §9. Code only. */
export const HooksSchema = z.strictObject({
  onRequest: FunctionSchema.optional(),
  onMessage: FunctionSchema.optional(),
  onPromptComposed: FunctionSchema.optional(),
  onToolCall: FunctionSchema.optional(),
  onStep: FunctionSchema.optional(),
  onFinish: FunctionSchema.optional(),
  onError: FunctionSchema.optional(),
  onFeedback: FunctionSchema.optional(),
})

/**
 * Everything a YAML, JSON or TOML file can express — docs/02-configuration.md §3.
 *
 * Deliberately kept free of functions and Zod instances so it round-trips
 * through `z.toJSONSchema()` and can be published for editor autocomplete
 * (docs/02 §14).
 */
const CommonShape = {
  version: z.literal(CONFIG_SCHEMA_VERSION).describe('Schema version. Currently must be 1.'),
  name: z.string().min(1).describe('Displayed as the panel title. Public.'),
  extends: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'chatbot.config.ts only — declarative files to merge under this one, applied left to right.',
    ),
  mode: z
    .enum(MODES)
    .default('chat')
    .describe(
      'The policy switch. chat: one step, readOnly tools only. agent: multi-step with approval gates.',
    ),
  backend: BackendSchema,
  prompt: PromptSchema,
  siteContext: SiteContextSchema.prefault({}),
  agent: AgentSchema.prefault({}),
  knowledge: KnowledgeSchema.prefault({}),
  storage: StorageSchema.prefault({ type: 'memory' }),
  ui: UiSchema.prefault({}),
  security: SecuritySchema.prefault({}),
  telemetry: TelemetrySchema.prefault({}),
}

/**
 * The published schema. `emitJsonSchema()` serialises exactly this, so anything
 * added here shows up in editors; anything code-only must go on
 * {@link RuntimeConfigSchema} instead.
 */
export const ConfigSchema = z
  .strictObject({
    ...CommonShape,
    tools: z.array(DeclarativeToolEntrySchema).default([]),
  })
  .describe('SiteBot configuration — see docs/02-configuration.md.')

/**
 * What `validateConfig` actually parses. Identical to {@link ConfigSchema} plus
 * the two things only `chatbot.config.ts` can supply: inline tool handlers and
 * lifecycle hooks.
 */
export const RuntimeConfigSchema = z.strictObject({
  ...CommonShape,
  tools: z.array(ToolEntrySchema).default([]),
  hooks: HooksSchema.optional(),
})

export type SiteBotConfig = z.output<typeof RuntimeConfigSchema>
export type SiteBotConfigInput = z.input<typeof RuntimeConfigSchema>
export type Hooks = z.output<typeof HooksSchema>
export type Mode = (typeof MODES)[number]

/**
 * Every key optional, all the way down — what a `chatbot.config.ts` supplies
 * when it layers over a declarative file.
 *
 * Arrays and functions are left whole on purpose. `tools[]` entries are merged
 * by name and replace outright (docs/02 §1), so half a tool is never a useful
 * thing to write, and letting the type express it would only defer the error to
 * runtime.
 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends (...args: any[]) => unknown
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T

/** A config fragment. Only legal when it declares `extends`. */
export type SiteBotConfigFragment = DeepPartial<SiteBotConfigInput>

/** A fragment that says what it is layering over. */
export type ExtendingConfig = SiteBotConfigFragment & {
  extends: string | string[]
}
