import { jsonSchema, tool, type ToolSet } from 'ai'
import type { ResolvedConfig, ToolEntry } from '@sitebot/config'
import { isMcpImport } from '@sitebot/config'
import type { RequestContext } from '../types.js'
import type { UIMessage } from 'ai'
import type { KnowledgeDeps } from '../knowledge/types.js'
import { retrieve } from '../knowledge/retrieve.js'
import { randomDelimiterId, untrustedBlock } from '../prompt/untrusted.js'
import { EngineError } from '../stream/errors.js'
import { loadModuleExport } from '../modules.js'
import { createHttpExecutor } from './http.js'
import type { HostResolver } from './http.js'
import { createMcpExecutor, expandMcpImport, McpClientPool, type StdioMcpConnector } from './mcp.js'
import { validateJsonSchema, type JsonSchemaObject } from './schema.js'

export const WIDGET_EFFECT = '__sitebotWidgetEffect'
export type WidgetEffect =
  | { type: 'data-navigate'; data: { path: string; newTab: boolean } }
  | {
      type: 'data-handoff'
      data: { target: Record<string, unknown>; ticketUrl?: string; message: string }
    }

export function widgetEffect(
  effect: WidgetEffect,
  result: Record<string, unknown>,
): Record<string, unknown> {
  return { ...result, [WIDGET_EFFECT]: effect }
}

export interface ToolRegistryOptions {
  config: ResolvedConfig
  ctx: RequestContext
  filter: (tool: { readOnly?: boolean }) => boolean
  fetchImpl?: typeof fetch
  baseDir?: string | null
  resolveHost?: HostResolver
  mcpPool?: McpClientPool
  connectStdioMcp?: StdioMcpConnector
  approvals: boolean
  isApprovalGranted?: (toolName: string, input: unknown) => Promise<boolean>
  /** Phase 6: the reachable knowledge index. Absent → tool is not registered. */
  knowledge?: KnowledgeDeps | null
  onEvent?: (
    event: 'feedback' | 'lead' | 'handoff',
    data: Record<string, unknown>,
  ) => void | Promise<void>
  transcript?: UIMessage[]
  /**
   * The `onToolCall` hook (docs/04 §9). Called before every server-side tool
   * runs; anything but `undefined` short-circuits the call and becomes its
   * result. Client tools run in the browser and never reach it.
   */
  onToolCall?: (call: { name: string; input: unknown }, ctx: RequestContext) => Promise<unknown>
}

export interface ToolRegistry {
  build(): Promise<ToolSet>
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
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
  const tools: ToolSet = {}
  for (const entry of options.config.tools) {
    if (isMcpImport(entry)) {
      if (entry.enabled === false || !options.filter(entry)) continue
      if (entry.scope === 'authenticated' && options.ctx.identity === null) continue
      try {
        for (const definition of await expandMcpImport(entry, options.mcpPool)) {
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
  if (options.onToolCall !== undefined) {
    const onToolCall = options.onToolCall
    for (const [name, built] of Object.entries(tools)) {
      const execute = (built as { execute?: (...args: unknown[]) => Promise<unknown> }).execute
      if (execute === undefined) continue
      ;(built as { execute: (...args: unknown[]) => Promise<unknown> }).execute = async (
        input: unknown,
        callOptions: unknown,
        ...rest: unknown[]
      ) => {
        const ctx =
          ((callOptions as { experimental_context?: unknown } | undefined)?.experimental_context as
            RequestContext | undefined) ?? options.ctx
        const shortCircuit = await onToolCall({ name, input }, ctx)
        return shortCircuit !== undefined ? shortCircuit : execute(input, callOptions, ...rest)
      }
    }
  }
  return tools
}

async function buildTool(
  entry: Exclude<ToolEntry, { from: 'mcp' }>,
  options: ResolvedToolRegistryOptions,
): Promise<ToolSet[string]> {
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
    ...(entry.executor?.type === 'builtin'
      ? {
          toModelOutput: ({ output }: { output: unknown }) => ({
            type: 'json' as const,
            value: isWidgetEffectResult(output) ? withoutWidgetEffect(output) : output,
          }),
        }
      : {}),
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

function isWidgetEffectResult(output: unknown): output is Record<string, unknown> {
  return typeof output === 'object' && output !== null && WIDGET_EFFECT in output
}

function withoutWidgetEffect(output: Record<string, unknown>): Record<string, unknown> {
  const { [WIDGET_EFFECT]: _effect, ...result } = output
  return result
}

async function resolveExecutor(
  entry: Exclude<ToolEntry, { from: 'mcp' }>,
  options: ResolvedToolRegistryOptions,
): Promise<((input: unknown, ctx: RequestContext) => Promise<unknown>) | undefined> {
  const executor = entry.executor
  const raw =
    entry.execute !== undefined
      ? async (input: unknown, ctx: RequestContext) =>
          (
            entry.execute as (value: unknown, context: RequestContext) => unknown | Promise<unknown>
          )(input, ctx)
      : executor?.type === 'http'
        ? createHttpExecutor(executor, options.fetchImpl, options.resolveHost)
        : executor?.type === 'builtin'
          ? builtinExecutor(executor.id, executor, options)
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

  return async (input, ctx) => {
    const parsed = validateJsonSchema(entry.parameters as JsonSchemaObject, input)
    if (!parsed.ok) return { error: 'invalid_input', issues: parsed.issues }
    if (
      entry.maxCallsPerSession !== undefined &&
      (await ctx.budget.toolCalls(entry.name)) >= entry.maxCallsPerSession
    )
      return { error: 'call_limit_reached' }
    try {
      const result = await withTimeout(
        entry.timeoutMs,
        () => raw(parsed.value as Record<string, unknown>, ctx),
        ctx.signal,
      )
      return entry.executor?.type === 'http' || entry.executor?.type === 'mcp'
        ? frameToolResult(result, `The text below was returned by tool ${entry.name}.`)
        : result
    } catch (error) {
      ctx.logger.error('tool failed', { name: entry.name, error })
      return { error: 'tool_failed', message: entry.errorMessage ?? 'The tool could not complete.' }
    }
  }
}

function buildMcpTool(
  definition: Awaited<ReturnType<typeof expandMcpImport>>[number],
  entry: Extract<ToolEntry, { from: 'mcp' }>,
  options: ResolvedToolRegistryOptions,
): ToolSet[string] {
  const requiresApproval =
    options.approvals && options.config.agent.approvalPolicy !== 'never' && entry.requiresApproval
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
    execute: async (input: unknown) => {
      const result = await withTimeout(
        entry.timeoutMs,
        () => definition.execute(input),
        options.ctx.signal,
      )
      return frameToolResult(result, `The text below was returned by MCP tool ${definition.name}.`)
    },
  } as unknown as Parameters<typeof tool>[0]) as unknown as ToolSet[string]
}

async function moduleExecutor(
  path: string,
  exportName: string,
  baseDir: string | null | undefined,
): Promise<(input: unknown, ctx: RequestContext) => Promise<unknown>> {
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

function builtinExecutor(
  id: string,
  config: Record<string, unknown>,
  options: ToolRegistryOptions,
) {
  return async (input: unknown, ctx: RequestContext): Promise<unknown> => {
    if (id === 'search_knowledge_base') {
      const knowledge = options.knowledge
      if (knowledge?.store === undefined || knowledge.embedder === undefined) {
        return { error: 'not_configured', tool: id }
      }
      const query =
        typeof input === 'object' && input !== null
          ? String((input as Record<string, unknown>).query ?? '')
          : ''
      if (query === '') return { error: 'invalid_input', issues: ['query is required'] }
      const result = await retrieve(
        { ...knowledge, store: knowledge.store, embedder: knowledge.embedder },
        query,
        options.config,
      )
      if (result.hits.length === 0) {
        return {
          results: [],
          note: 'No relevant documentation found. Say so rather than guessing.',
        }
      }
      return {
        results: result.hits.map((hit, index) => ({
          n: index + 1,
          title: hit.title,
          url: hit.url,
          text: hit.text,
          score: hit.score,
        })),
      }
    }
    switch (id) {
      case 'list_site_sections':
        return options.config.siteContext.routes
      case 'get_page_context':
        return ctx.pageContext
      case 'get_time': {
        const timezone =
          typeof input === 'object' &&
          input !== null &&
          typeof (input as Record<string, unknown>).timezone === 'string'
            ? String((input as Record<string, unknown>).timezone)
            : 'UTC'
        return {
          timezone,
          iso: new Date().toISOString(),
          local: new Intl.DateTimeFormat('en', {
            dateStyle: 'full',
            timeStyle: 'long',
            timeZone: timezone,
          }).format(),
        }
      }
      case 'submit_feedback':
        await options.onEvent?.('feedback', {
          ...(typeof input === 'object' && input !== null
            ? (input as Record<string, unknown>)
            : {}),
          sessionId: ctx.sessionId,
        })
        return { accepted: true, message: 'Feedback recorded.' }
      case 'collect_lead': {
        const lead =
          typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
        await options.onEvent?.('lead', { ...lead, sessionId: ctx.sessionId })
        return { accepted: true, lead }
      }
      case 'navigate': {
        const path =
          typeof input === 'object' && input !== null
            ? (input as Record<string, unknown>).path
            : undefined
        if (
          typeof path !== 'string' ||
          !options.config.siteContext.routes.some((route) => route.path === path)
        )
          return { error: 'route_not_allowed' }
        const newTab =
          typeof input === 'object' &&
          input !== null &&
          (input as Record<string, unknown>).newTab === true
        return widgetEffect(
          { type: 'data-navigate', data: { path, newTab } },
          { accepted: true, path },
        )
      }
      case 'handoff': {
        const target = (config.target as Record<string, unknown> | undefined) ?? null
        const message =
          typeof config.message === 'string' ? config.message : 'A human will follow up shortly.'
        const transcript = target?.includeTranscript === true ? options.transcript : undefined
        let ticketUrl = handoffUrl(target)
        if (target?.kind === 'webhook' && typeof target.url === 'string') {
          const fetchImpl = options.fetchImpl ?? globalThis.fetch
          if (!fetchImpl) return { error: 'not_configured', tool: id }
          const response = await fetchImpl(target.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: ctx.sessionId, message, input, transcript }),
            signal: ctx.signal,
          })
          if (!response.ok) return { error: 'handoff_failed', status: response.status }
          const body = (await response.json().catch(() => null)) as { ticketUrl?: unknown } | null
          if (typeof body?.ticketUrl === 'string') ticketUrl = body.ticketUrl
        }
        await options.onEvent?.('handoff', {
          target: target ?? {},
          message,
          transcript,
          ticketUrl,
          sessionId: ctx.sessionId,
        })
        return widgetEffect(
          {
            type: 'data-handoff',
            data: {
              target: target ?? {},
              ...(ticketUrl === undefined ? {} : { ticketUrl }),
              message,
            },
          },
          {
            accepted: true,
            target,
            message,
          },
        )
      }
      default:
        return { error: 'not_configured', tool: id }
    }
  }
}

function handoffUrl(target: Record<string, unknown> | null): string | undefined {
  if (typeof target?.url === 'string') return target.url
  if (target?.kind === 'email' && typeof target.email === 'string')
    return `mailto:${encodeURIComponent(target.email)}`
  return undefined
}

function builtinDescription(name: string): string {
  return `Use ${name.replaceAll('_', ' ')} when the user asks for this information.`
}
function frameToolResult(result: unknown, source: string): unknown {
  const content = typeof result === 'string' ? result : JSON.stringify(result)
  if (content.length < 2_000) return result
  return untrustedBlock({
    tag: 'tool_result',
    source,
    content,
    delimiterId: randomDelimiterId(),
  })
}
function isDevelopment(): boolean {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.NODE_ENV === 'development'
  )
}
async function withTimeout<T>(
  ms: number,
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('tool timeout')), ms)
  })
  try {
    return await Promise.race([operation(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
