import { z } from 'zod'
import {
  FunctionSchema,
  JsonSchemaObjectSchema,
  ToolNameSchema,
  ZodSchemaSchema,
} from './primitives.js'

export const EXECUTOR_KINDS = ['http', 'mcp', 'module', 'builtin', 'client'] as const
export const TOOL_SCOPES = ['public', 'authenticated'] as const
export const APPROVAL_RISKS = ['low', 'medium', 'high'] as const
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const
export const MCP_TRANSPORTS = ['http', 'sse', 'stdio'] as const

/** docs/05-tools.md §4. */
export const BUILTIN_TOOL_IDS = [
  'search_knowledge_base',
  'list_site_sections',
  'get_page_context',
  'handoff',
  'navigate',
  'collect_lead',
  'submit_feedback',
  'get_time',
] as const

/** docs/05-tools.md §5. */
export const BUILTIN_CLIENT_TOOL_IDS = [
  'highlight',
  'navigate',
  'fill_form',
  'read_element',
  'get_page_context',
  'open_url',
  'copy_to_clipboard',
] as const

export const HANDOFF_TARGET_KINDS = [
  'webhook',
  'intercom',
  'crisp',
  'zendesk',
  'email',
  'url',
] as const

// ── executors ───────────────────────────────────────────────────────────────

/**
 * docs/05-tools.md §2. The security-relevant fields (`allowHosts`,
 * `allowPrivateNetwork`, `maxRedirects`, `maxResponseBytes`) are part of the
 * schema from day one rather than added later, so a config written today keeps
 * working when Phase 5 starts enforcing them.
 */
export const HttpExecutorSchema = z.strictObject({
  type: z.literal('http'),
  method: z.enum(HTTP_METHODS).default('GET'),
  url: z
    .string()
    .min(1)
    .describe(
      'Target URL. {param} placeholders are percent-encoded and may not appear in the scheme or host.',
    ),
  headers: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      'Static headers plus {{identity.*}} / {{session.*}} context. Model-controlled {param} is forbidden here.',
    ),
  query: z.record(z.string(), z.string()).default({}),
  body: z
    .unknown()
    .optional()
    .describe(
      'Request body template. Defaults to the validated argument object on POST/PUT/PATCH.',
    ),
  timeoutMs: z.number().int().positive().optional(),
  responsePath: z
    .string()
    .optional()
    .describe('JSONPath applied to the response before the model sees it.'),
  maxResponseBytes: z.number().int().positive().default(65_536),
  errorMap: z
    .record(z.string(), z.string())
    .default({})
    .describe('HTTP status code to a model-readable message.'),
  allowHosts: z
    .array(z.string().min(1))
    .optional()
    .describe('SSRF allowlist. Defaults to the host literally written in `url` (docs/08 §5).'),
  allowPrivateNetwork: z.boolean().default(false),
  maxRedirects: z.number().int().min(0).default(0),
})

export const McpStdioServerSchema = z.strictObject({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
})

export const McpRemoteServerSchema = z.strictObject({
  transport: z.enum(['http', 'sse']),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
})

export const McpServerSchema = z.discriminatedUnion('transport', [
  McpRemoteServerSchema,
  McpStdioServerSchema,
])

export const McpExecutorSchema = z.strictObject({
  type: z.literal('mcp'),
  server: McpServerSchema,
  tool: z.string().min(1).describe('Tool name as the server exposes it.'),
})

export const ModuleExecutorSchema = z.strictObject({
  type: z.literal('module'),
  path: z.string().min(1).describe('Module path, resolved relative to the config file.'),
  export: z.string().min(1).default('default'),
})

export const HandoffTargetSchema = z.strictObject({
  kind: z.enum(HANDOFF_TARGET_KINDS),
  url: z.string().optional(),
  email: z.string().optional(),
  includeTranscript: z.boolean().default(false),
})

/**
 * `builtin` carries per-id options. They are collected in one object rather
 * than a discriminated union on `id` because most ids take none, and the two
 * that do (`search_knowledge_base`, `handoff`) would otherwise dominate the
 * shape of the schema for very little gain.
 */
export const BuiltinExecutorSchema = z.strictObject({
  type: z.literal('builtin'),
  id: z.enum(BUILTIN_TOOL_IDS),
  // search_knowledge_base
  topK: z.number().int().positive().optional(),
  minScore: z.number().min(0).max(1).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  // handoff
  target: HandoffTargetSchema.optional(),
  message: z.string().optional(),
})

export const ClientExecutorSchema = z.strictObject({
  type: z.literal('client'),
  id: z
    .string()
    .min(1)
    .describe('A builtin client tool id, or a name registered via SiteBot.registerTool().'),
})

export const ExecutorSchema = z.discriminatedUnion('type', [
  HttpExecutorSchema,
  McpExecutorSchema,
  ModuleExecutorSchema,
  BuiltinExecutorSchema,
  ClientExecutorSchema,
])

// ── tools ───────────────────────────────────────────────────────────────────

const ToolShape = {
  name: ToolNameSchema,
  description: z
    .string()
    .optional()
    .describe(
      'What the model reads to decide whether to call this. Required except for builtin executors.',
    ),
  parameters: JsonSchemaObjectSchema.prefault({}),
  readOnly: z
    .boolean()
    .default(false)
    .describe('Declares no side effects. Must be true in chat mode.'),
  scope: z.enum(TOOL_SCOPES).default('public'),
  requiresApproval: z.boolean().default(false),
  approvalRisk: z.enum(APPROVAL_RISKS).default('medium'),
  approvalSummary: z
    .string()
    .optional()
    .describe('Human-readable summary shown on the approval card.'),
  executor: ExecutorSchema,
  enabled: z
    .union([z.boolean(), z.string()])
    .default(true)
    .describe('A string is treated as a condition, e.g. "${env.FEATURE_ORDERS}".'),
  timeoutMs: z.number().int().positive().default(10_000),
  maxCallsPerSession: z.number().int().positive().optional(),
  errorMessage: z.string().optional().describe('Shown to the model when the executor fails.'),
}

export const DeclarativeToolSchema = z.strictObject(ToolShape).check((ctx) => {
  if (ctx.value.description === undefined && ctx.value.executor.type !== 'builtin') {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      path: ['description'],
      message:
        'A tool description is required — it is what the model reads to decide when to call the tool.',
    })
  }
})

/**
 * The `chatbot.config.ts` form: `parameters` may be a Zod schema and `execute`
 * may replace the declarative executor entirely (docs/02 §1).
 */
export const CodeToolSchema = z
  .strictObject({
    ...ToolShape,
    parameters: z.union([JsonSchemaObjectSchema, ZodSchemaSchema]).prefault({}),
    executor: ExecutorSchema.optional(),
    execute: FunctionSchema.optional(),
  })
  .check((ctx) => {
    const { executor, execute, description } = ctx.value
    if (executor === undefined && execute === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['executor'],
        message:
          'A tool needs either an `executor` or, from chatbot.config.ts, an inline `execute` function.',
      })
    }
    if (description === undefined && executor?.type !== 'builtin') {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['description'],
        message:
          'A tool description is required — it is what the model reads to decide when to call the tool.',
      })
    }
  })

// ── bulk MCP import ─────────────────────────────────────────────────────────

/**
 * `- from: mcp` imports a whole server's toolset (docs/05-tools.md §3).
 * Omitting `allow` is a warning, not an error, because it is the natural thing
 * to write while exploring — but it means a server update can silently hand the
 * assistant new capabilities, so `security.strictTools` turns it into an error.
 */
export const McpImportSchema = z.strictObject({
  from: z.literal('mcp'),
  id: z.string().min(1).describe('Identifies this server in health checks and telemetry.'),
  server: McpServerSchema,
  allow: z
    .array(z.string().min(1))
    .optional()
    .describe('Tool names to import. Strongly recommended in production.'),
  deny: z.array(z.string().min(1)).default([]),
  prefix: z.string().default('').describe('Prepended to imported tool names to avoid collisions.'),
  readOnly: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
  scope: z.enum(TOOL_SCOPES).default('public'),
  timeoutMs: z.number().int().positive().default(15_000),
  enabled: z.union([z.boolean(), z.string()]).default(true),
})

export const DeclarativeToolEntrySchema = z.union([McpImportSchema, DeclarativeToolSchema])

export const ToolEntrySchema = z.union([McpImportSchema, CodeToolSchema])

export type Executor = z.output<typeof ExecutorSchema>
export type ToolEntry = z.output<typeof ToolEntrySchema>
export type Tool = z.output<typeof CodeToolSchema>
export type McpImport = z.output<typeof McpImportSchema>

/** Narrow a tools[] entry to the single-tool form. */
export function isMcpImport(entry: ToolEntry): entry is McpImport {
  return 'from' in entry && entry.from === 'mcp'
}
