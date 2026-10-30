import { z } from 'zod'
import { compileToolSchema } from '../tool-schema.js'
import { FunctionSchema, ToolNameSchema, ZodSchemaSchema } from './primitives.js'

export const EXECUTOR_KINDS = ['http', 'mcp', 'module', 'client'] as const
export const TOOL_SCOPES = ['public', 'authenticated'] as const
export const APPROVAL_RISKS = ['low', 'medium', 'high'] as const
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const
export const MCP_TRANSPORTS = ['http', 'sse', 'stdio'] as const

/** docs/05-tools.md §4. */
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
  tool: z
    .string()
    .min(1)
    .regex(/^[^*]+$/, 'Register one exact MCP tool name; wildcards are not supported.')
    .describe('Explicit tool name as the server exposes it.'),
})

export const ModuleExecutorSchema = z.strictObject({
  type: z.literal('module'),
  path: z.string().min(1).describe('Module path, resolved relative to the config file.'),
  export: z.string().min(1).default('default'),
})

export const ClientExecutorSchema = z.strictObject({
  type: z.literal('client'),
  id: z
    .string()
    .min(1)
    .describe('An application handler id registered via SiteBot.registerTool().'),
})

export const ExecutorSchema = z.discriminatedUnion('type', [
  HttpExecutorSchema,
  McpExecutorSchema,
  ModuleExecutorSchema,
  ClientExecutorSchema,
])

// ── tools ───────────────────────────────────────────────────────────────────

const ToolShape = {
  name: ToolNameSchema,
  description: z.string().trim().min(1).describe('Application-owned tool description.'),
  parameters: z
    .record(z.string(), z.unknown())
    .describe('Complete input JSON Schema; object root required.'),
  outputSchema: z
    .record(z.string(), z.unknown())
    .describe('Required result JSON Schema, checked for every transport.'),
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

function checkSchemas(
  ctx: z.core.ParsePayload<{
    parameters: Record<string, unknown> | z.ZodType
    outputSchema: Record<string, unknown> | z.ZodType
  }>,
) {
  for (const field of ['parameters', 'outputSchema'] as const) {
    try {
      compileToolSchema(ctx.value[field], field === 'parameters')
    } catch {
      ctx.issues.push({
        code: 'custom',
        input: undefined,
        path: [field],
        message: 'Invalid or unsupported tool schema.',
      })
    }
  }
}

/** Environment interpolation yields strings; unresolved conditions grant nothing. */
export function isToolEnabled(enabled: boolean | string): boolean {
  return enabled === true || enabled === 'true'
}

export const DeclarativeToolSchema = z.strictObject(ToolShape).check(checkSchemas)

/** Typed server registrations retain native Zod validation and transforms. */
export const CodeToolSchema = z
  .strictObject({
    ...ToolShape,
    parameters: z.union([ZodSchemaSchema, z.record(z.string(), z.unknown())]),
    outputSchema: z.union([ZodSchemaSchema, z.record(z.string(), z.unknown())]),
    executor: ExecutorSchema.optional(),
    execute: FunctionSchema.optional(),
  })
  .check((ctx) => {
    if ((ctx.value.executor === undefined) === (ctx.value.execute === undefined)) {
      ctx.issues.push({
        code: 'custom',
        input: undefined,
        path: ['executor'],
        message: 'A tool requires exactly one executor or inline execute handler.',
      })
    }
    checkSchemas(ctx)
  })

export const DeclarativeToolEntrySchema = DeclarativeToolSchema
export const ToolEntrySchema = CodeToolSchema
export type Executor = z.output<typeof ExecutorSchema>
export type ToolEntry = z.output<typeof ToolEntrySchema>
export type Tool = z.output<typeof CodeToolSchema>
