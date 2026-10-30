import { createTranslator } from '@sitebot/config/i18n'
import { jsonSchema, tool, type ToolSet } from 'ai'
import type { ResolvedConfig, ToolEntry } from '@sitebot/config'
import { compileToolSchema, CodeToolSchema, isToolEnabled } from '@sitebot/config'
import type { RequestContext, ToolContext } from '../types.js'
import { SourceEvidence } from '../sources/evidence.js'
import { EngineError } from '../stream/errors.js'
import { loadModuleExport } from '../modules.js'
import { createHttpExecutor } from './http.js'
import type { HostResolver } from './http.js'
import { createMcpExecutor, McpClientPool, type StdioMcpConnector } from './mcp.js'
import { withDeadline, checkDeadline } from '../deadline.js'
import { randomDelimiterId, untrustedBlock } from '../prompt/untrusted.js'
import { snapshotToolValue } from './schema.js'

export interface ToolRegistryOptions {
  config: ResolvedConfig
  ctx: RequestContext
  filter: (tool: { readOnly?: boolean }) => boolean
  fetchImpl?: typeof fetch
  baseDir?: string | null
  resolveHost?: HostResolver
  mcpPool?: McpClientPool
  connectStdioMcp?: StdioMcpConnector
  claimToolCall?: (name: string, limit: number) => Promise<boolean>
  isCallApproved?: (name: string, input: unknown, callId?: string) => boolean
  /** Current step authorization; providers may ignore toolChoice. */
  canExecute?: () => boolean
  approvals: boolean
  isApprovalGranted?: (toolName: string, input: unknown) => Promise<boolean>
  sourceEvidence?: SourceEvidence
  onToolCall?: (call: { name: string; input: unknown }, ctx: ToolContext) => Promise<void>
}

export interface ToolRegistry {
  build(): Promise<ToolSet>
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  options = {
    ...options,
    sourceEvidence: options.sourceEvidence ?? new SourceEvidence(),
  }
  const mcpPool =
    options.mcpPool ??
    new McpClientPool({
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.connectStdioMcp === undefined ? {} : { connectStdio: options.connectStdioMcp }),
    })
  return { build: async () => buildTools({ ...options, mcpPool }) }
}

type ResolvedToolRegistryOptions = ToolRegistryOptions & { mcpPool: McpClientPool }

async function buildTools(options: ResolvedToolRegistryOptions): Promise<ToolSet> {
  const tools: ToolSet = Object.create(null) as ToolSet
  for (const rawEntry of options.config.tools) {
    // Recheck even when a caller bypasses validateConfig or mutates a resolved config.
    const checked = CodeToolSchema.safeParse(rawEntry)
    if (!checked.success) throw new EngineError('not_ready')
    const entry = checked.data
    if (Object.hasOwn(tools, entry.name)) throw new EngineError('not_ready')
    if (!isToolEnabled(entry.enabled) || !options.filter(entry)) continue
    if (entry.scope === 'authenticated' && options.ctx.identity === null) continue
    tools[entry.name] = await buildTool(entry, options)
  }
  return tools
}

async function buildTool(
  entry: ToolEntry,
  options: ResolvedToolRegistryOptions,
): Promise<ToolSet[string]> {
  const input = compileToolSchema(entry.parameters, true)
  const output = compileToolSchema(entry.outputSchema)
  if (entry.maxCallsPerSession !== undefined && options.claimToolCall === undefined)
    throw new EngineError('not_ready')
  const raw = await withDeadline(entry.timeoutMs, options.ctx.signal, async () =>
    resolveExecutor(entry, options),
  )
  const requiresApproval =
    options.config.agent.approvalPolicy !== 'never' &&
    (entry.requiresApproval || options.config.agent.approvalRequired.includes(entry.name))
  return tool({
    description: entry.description,
    // Validate here without applying native transforms twice; the executor owns transforms.
    inputSchema: jsonSchema(input.jsonSchema as never, {
      validate: async (value: unknown) => {
        const valid = input.validate(value)
        return valid
          ? { success: true, value }
          : { success: false, error: new Error('Invalid tool input.') }
      },
    }),
    ...(requiresApproval
      ? {
          needsApproval: async (value: unknown) =>
            options.canExecute?.() !== false &&
            !(await options.isApprovalGranted?.(entry.name, value)),
        }
      : {}),
    metadata: { sitebot: { name: entry.name, readOnly: entry.readOnly, risk: entry.approvalRisk } },
    toModelOutput: ({ output: result }: { output: unknown }) => ({
      type: 'json' as const,
      value:
        entry.executor?.type === 'http' || entry.executor?.type === 'mcp'
          ? frameToolResult(result, entry.name)
          : result,
    }),
    ...(raw === undefined
      ? {}
      : {
          execute: async (value: unknown, callOptions?: { toolCallId?: string }) => {
            const ctx = options.ctx
            let staged: ReturnType<SourceEvidence['beginCall']> | undefined
            let publish = false
            try {
              const accepted = await withDeadline(entry.timeoutMs, ctx.signal, async (signal) => {
                if (
                  !isToolEnabled(entry.enabled) ||
                  !options.filter(entry) ||
                  (entry.scope === 'authenticated' && ctx.identity === null)
                )
                  return { error: 'tool_unavailable' }
                const parsed = await input.parse(value)
                checkDeadline(signal)
                if (!parsed.ok) return { error: 'invalid_input' }
                const callApproved =
                  options.isCallApproved?.(entry.name, value, callOptions?.toolCallId) ?? false
                if (options.canExecute?.() === false && !callApproved)
                  return { error: 'tool_unavailable' }
                if (
                  requiresApproval &&
                  !(await options.isApprovalGranted?.(entry.name, value)) &&
                  !callApproved
                )
                  return { error: 'approval_required' }
                if (
                  entry.maxCallsPerSession !== undefined &&
                  !(await options.claimToolCall!(entry.name, entry.maxCallsPerSession))
                )
                  return { error: 'call_limit_reached' }
                checkDeadline(signal)
                staged = options.sourceEvidence!.beginCall(signal)
                const callCtx: ToolContext = { ...ctx, signal, sources: staged.sources }
                await options.onToolCall?.({ name: entry.name, input: parsed.value }, callCtx)
                checkDeadline(signal)
                const result = await raw(parsed.value, callCtx)
                checkDeadline(signal)
                let snapshot: unknown
                try {
                  snapshot = snapshotToolValue(result)
                } catch {
                  return { error: 'invalid_output' }
                }
                const checked = await output.parse(snapshot)
                checkDeadline(signal)
                if (!checked.ok) return { error: 'invalid_output' }
                let validated: unknown
                try {
                  validated = snapshotToolValue(checked.value)
                } catch {
                  return { error: 'invalid_output' }
                }
                publish = true
                return validated
              })
              // Commit only after the deadline race accepts the fully validated result.
              // A late operation retains only its own closed staging object.
              if (publish) {
                checkDeadline(ctx.signal)
                staged?.commit()
              }
              return accepted
            } catch {
              return {
                error: ctx.signal.aborted ? 'aborted' : 'tool_failed',
                message:
                  entry.errorMessage ??
                  createTranslator(options.config.ui, ctx.locale)('toolError'),
              }
            } finally {
              staged?.close()
            }
          },
        }),
  } as unknown as Parameters<typeof tool>[0]) as unknown as ToolSet[string]
}

/** Framing belongs to model conversion, after validation; clients retain the declared shape. */
function frameToolResult(result: unknown, name: string): unknown {
  const content = typeof result === 'string' ? result : JSON.stringify(result)
  if (content.length < 2_000) return result
  return untrustedBlock({
    tag: 'tool_result',
    source: `The text below was returned by tool ${name}.`,
    content,
    delimiterId: randomDelimiterId(),
  })
}

async function resolveExecutor(
  entry: ToolEntry,
  options: ResolvedToolRegistryOptions,
): Promise<((input: unknown, ctx: ToolContext) => Promise<unknown>) | undefined> {
  const executor = entry.executor
  const raw =
    entry.execute !== undefined
      ? async (input: unknown, ctx: ToolContext) =>
          (entry.execute as (value: unknown, context: ToolContext) => unknown | Promise<unknown>)(
            input,
            ctx,
          )
      : executor?.type === 'http'
        ? createHttpExecutor(executor, options.fetchImpl, options.resolveHost)
        : executor?.type === 'module'
          ? await moduleExecutor(executor.path, executor.export, options.baseDir)
          : executor?.type === 'mcp'
            ? await createMcpExecutor(entry, options.mcpPool)
            : executor?.type === 'client'
              ? undefined
              : undefined
  if (raw === undefined && executor?.type !== 'client')
    throw new EngineError('not_ready', {
      message: `Tool "${entry.name}" has no executable handler.`,
    })
  if (raw === undefined) return undefined

  return async (input, ctx) => raw(input as Record<string, unknown>, ctx)
}

async function moduleExecutor(
  path: string,
  exportName: string,
  baseDir: string | null | undefined,
): Promise<(input: unknown, ctx: ToolContext) => Promise<unknown>> {
  const handler = await loadModuleExport(path, exportName, {
    baseDir,
    fresh: isDevelopment(),
    kind: 'Module tool',
  })
  if (typeof handler !== 'function')
    throw new EngineError('not_ready', {
      message: `Module tool export "${exportName}" is not a function.`,
    })
  return async (input, ctx) => handler(input, ctx)
}

function isDevelopment(): boolean {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.NODE_ENV === 'development'
  )
}
