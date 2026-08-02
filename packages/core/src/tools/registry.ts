import { jsonSchema, tool, type ToolSet } from 'ai'
import type { ResolvedConfig, ToolEntry } from '@sitebot/config'
import { isMcpImport } from '@sitebot/config'
import type { RequestContext } from '../types.js'
import { EngineError } from '../stream/errors.js'
import { createHttpExecutor } from './http.js'
import type { HostResolver } from './http.js'
import { createMcpExecutor, expandMcpImport } from './mcp.js'
import type { StdioMcpConnector } from './mcp.js'
import { validateJsonSchema, type JsonSchemaObject } from './schema.js'

export interface ToolRegistryOptions {
  config: ResolvedConfig
  ctx: RequestContext
  filter: (tool: { readOnly?: boolean }) => boolean
  fetchImpl?: typeof fetch
  baseDir?: string | null
  resolveHost?: HostResolver
  connectStdioMcp?: StdioMcpConnector
  approvals: boolean
  isApprovalGranted?: (toolName: string, input: unknown) => Promise<boolean>
}

export interface ToolRegistry {
  build(): Promise<ToolSet>
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  return { build: async () => buildTools(options) }
}

async function buildTools(options: ToolRegistryOptions): Promise<ToolSet> {
  const tools: ToolSet = {}
  for (const entry of options.config.tools) {
    if (isMcpImport(entry)) {
      if (entry.enabled === false || !options.filter(entry)) continue
      if (entry.scope === 'authenticated' && options.ctx.identity === null) continue
      try {
        for (const definition of await expandMcpImport(entry, options.fetchImpl, options.connectStdioMcp)) {
          tools[definition.name] = buildMcpTool(definition, entry, options)
        }
      } catch (error) {
        options.ctx.logger.warn('MCP server unavailable; tools omitted', { id: entry.id, error })
      }
      continue
    }
    if (entry.enabled === false || !options.filter(entry)) continue
    if (entry.scope === 'authenticated' && options.ctx.identity === null) continue
    tools[entry.name] = await buildTool(entry, options)
  }
  return tools
}

async function buildTool(entry: Exclude<ToolEntry, { from: 'mcp' }>, options: ToolRegistryOptions): Promise<ToolSet[string]> {
  const schema = entry.parameters as JsonSchemaObject
  const execute = await resolveExecutor(entry, options)
  const requiresApproval =
    options.approvals &&
    options.config.agent.approvalPolicy !== 'never' &&
    (entry.requiresApproval || options.config.agent.approvalRequired.includes(entry.name))
  return tool({
    description: entry.description ?? builtinDescription(entry.name),
    inputSchema: jsonSchema(schema as never),
    ...(requiresApproval
      ? {
          needsApproval: async (input: unknown) =>
            !(await options.isApprovalGranted?.(entry.name, input)),
        }
      : {}),
    metadata: { sitebot: { name: entry.name, readOnly: entry.readOnly, risk: entry.approvalRisk } },
    ...(execute === undefined
      ? {}
      : {
          execute: async (input: unknown, callOptions: { experimental_context?: unknown }) => {
            const ctx = callOptions.experimental_context as RequestContext | undefined
            return execute(input, ctx ?? options.ctx)
          },
        }),
  } as unknown as Parameters<typeof tool>[0]) as unknown as ToolSet[string]
}

async function resolveExecutor(entry: Exclude<ToolEntry, { from: 'mcp' }>, options: ToolRegistryOptions): Promise<((input: unknown, ctx: RequestContext) => Promise<unknown>) | undefined> {
  const executor = entry.executor
  const raw = entry.execute !== undefined
    ? async (input: unknown, ctx: RequestContext) => (entry.execute as (value: unknown, context: RequestContext) => unknown | Promise<unknown>)(input, ctx)
    : executor?.type === 'http'
      ? createHttpExecutor(executor, options.fetchImpl, options.resolveHost)
      : executor?.type === 'builtin'
        ? builtinExecutor(executor.id, executor, options)
      : executor?.type === 'module'
          ? await moduleExecutor(executor.path, executor.export, options.baseDir)
          : executor?.type === 'mcp'
            ? await createMcpExecutor(entry, options.fetchImpl, options.connectStdioMcp)
          : executor?.type === 'client'
            ? undefined
            : undefined
  if (raw === undefined && executor?.type !== 'client') throw new EngineError('not_ready', { message: `Tool "${entry.name}" has no executable handler.` })
  if (raw === undefined) return undefined

  return async (input, ctx) => {
    const parsed = validateJsonSchema(entry.parameters as JsonSchemaObject, input)
    if (!parsed.ok) return { error: 'invalid_input', issues: parsed.issues }
    if (entry.maxCallsPerSession !== undefined && await ctx.budget.toolCalls(entry.name) >= entry.maxCallsPerSession) return { error: 'call_limit_reached' }
    try {
      return await withTimeout(entry.timeoutMs, () => raw(parsed.value as Record<string, unknown>, ctx), ctx.signal)
    } catch (error) {
      ctx.logger.error('tool failed', { name: entry.name, error })
      return { error: 'tool_failed', message: entry.errorMessage ?? 'The tool could not complete.' }
    }
  }
}

function buildMcpTool(
  definition: Awaited<ReturnType<typeof expandMcpImport>>[number],
  entry: Extract<ToolEntry, { from: 'mcp' }>,
  options: ToolRegistryOptions,
): ToolSet[string] {
  const requiresApproval =
    options.approvals &&
    options.config.agent.approvalPolicy !== 'never' &&
    entry.requiresApproval
  return tool({
    description: definition.description,
    inputSchema: jsonSchema(definition.parameters as never),
    ...(requiresApproval
      ? {
          needsApproval: async (input: unknown) =>
            !(await options.isApprovalGranted?.(definition.name, input)),
        }
      : {}),
    metadata: { sitebot: { name: definition.name, readOnly: entry.readOnly, source: entry.id } },
    execute: async (input: unknown) =>
      withTimeout(entry.timeoutMs, () => definition.execute(input), options.ctx.signal),
  } as unknown as Parameters<typeof tool>[0]) as unknown as ToolSet[string]
}

async function moduleExecutor(path: string, exportName: string, baseDir: string | null | undefined): Promise<(input: unknown, ctx: RequestContext) => Promise<unknown>> {
  const resolved = new URL(path, `file://${baseDir ?? process.cwd()}/`).href
  const module = await import(`${resolved}${isDevelopment() ? `?t=${Date.now()}` : ''}`) as Record<string, unknown>
  const handler = module[exportName]
  if (typeof handler !== 'function') throw new EngineError('not_ready', { message: `Module tool export "${exportName}" is not a function.` })
  return async (input, ctx) => handler(input, ctx)
}

function builtinExecutor(id: string, config: Record<string, unknown>, options: ToolRegistryOptions) {
  return async (input: unknown, ctx: RequestContext): Promise<unknown> => {
    switch (id) {
      case 'list_site_sections': return options.config.siteContext.routes
      case 'get_page_context': return ctx.pageContext
      case 'get_time': {
        const timezone = typeof input === 'object' && input !== null && typeof (input as Record<string, unknown>).timezone === 'string' ? String((input as Record<string, unknown>).timezone) : 'UTC'
        return { timezone, iso: new Date().toISOString(), local: new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'long', timeZone: timezone }).format() }
      }
      case 'submit_feedback': return { accepted: true, message: 'Feedback recorded.' }
      case 'navigate': return { path: typeof input === 'object' && input !== null ? (input as Record<string, unknown>).path : undefined }
      case 'handoff': return { accepted: true, target: config.target ?? null, message: config.message ?? 'A human will follow up shortly.' }
      default: return { error: 'not_configured', tool: id }
    }
  }
}

function builtinDescription(name: string): string { return `Use ${name.replaceAll('_', ' ')} when the user asks for this information.` }
function isDevelopment(): boolean { return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === 'development' }
async function withTimeout<T>(ms: number, operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('tool timeout')), ms) })
  try { return await Promise.race([operation(), timeout]) } finally { if (timer !== undefined) clearTimeout(timer) }
}
