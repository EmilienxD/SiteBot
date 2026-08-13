import type { McpImport, ToolEntry } from '@sitebot/config'
import { randomDelimiterId, untrustedBlock } from '../prompt/untrusted.js'
import { EngineError } from '../stream/errors.js'
import type { HealthStatus } from '../types.js'
import type { JsonSchemaObject } from './schema.js'

export type McpServer = McpImport['server']
type RemoteServer = Extract<McpServer, { transport: 'http' | 'sse' }>
export type StdioServer = Extract<McpServer, { transport: 'stdio' }>

export interface McpToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaObject
  execute(input: unknown): Promise<unknown>
}

export interface McpConnection {
  list(): Promise<Array<{ name: string; description?: string; inputSchema: JsonSchemaObject }>>
  call(name: string, input: unknown): Promise<unknown>
  ping(): Promise<void>
  close(): Promise<void>
}

export type McpConnector = (server: McpServer) => Promise<McpConnection>
export type StdioMcpConnector = (server: StdioServer) => Promise<McpConnection>

export interface McpHealthCheck {
  status: HealthStatus
  latencyMs: number
  transport: McpServer['transport']
  error?: string
}

export interface McpClientPoolOptions {
  fetchImpl?: typeof fetch
  connectStdio?: StdioMcpConnector
  connect?: McpConnector
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  initialBackoffMs?: number
  maxBackoffMs?: number
}

interface PoolEntry {
  fingerprint: string
  server: McpServer
  connection?: McpConnection
  pending?: Promise<McpConnection>
  failures: number
  retryAt: number
}

const DEFAULT_INITIAL_BACKOFF_MS = 250
const DEFAULT_MAX_BACKOFF_MS = 30_000

/**
 * Process-lifetime MCP connection pool. Engines create one pool and reuse it
 * across every request, so tool registry construction never creates a fresh
 * transport. Connections remain lazy until a tool list, call, or health probe
 * actually needs them.
 */
export class McpClientPool {
  readonly #entries = new Map<string, PoolEntry>()
  readonly #connect: McpConnector
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #initialBackoffMs: number
  readonly #maxBackoffMs: number

  constructor(options: McpClientPoolOptions = {}) {
    this.#connect =
      options.connect ??
      ((server) =>
        server.transport === 'stdio'
          ? (options.connectStdio?.(server) ??
            Promise.reject(
              new EngineError('not_ready', {
                message: 'MCP stdio transport requires @sitebot/core/node.',
              }),
            ))
          : connectRemote(server, options.fetchImpl))
    this.#now = options.now ?? (() => Date.now())
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  }

  connection(id: string, server: McpServer): McpConnection {
    const run = <T>(operation: (connection: McpConnection) => Promise<T>) =>
      this.#run(id, server, operation)
    return {
      list: () => run((connection) => connection.list()),
      call: (name, input) => run((connection) => connection.call(name, input)),
      ping: () => run((connection) => connection.ping()),
      close: () => this.#remove(id),
    }
  }

  async health(id: string, server: McpServer): Promise<McpHealthCheck> {
    const started = this.#now()
    try {
      await this.connection(id, server).ping()
      return {
        status: 'ok',
        latencyMs: this.#now() - started,
        transport: server.transport,
      }
    } catch (error) {
      return {
        status: 'degraded',
        latencyMs: this.#now() - started,
        transport: server.transport,
        error: errorMessage(error),
      }
    }
  }

  async dispose(): Promise<void> {
    const ids = [...this.#entries.keys()]
    await Promise.all(ids.map((id) => this.#remove(id)))
  }

  async #run<T>(
    id: string,
    server: McpServer,
    operation: (connection: McpConnection) => Promise<T>,
  ): Promise<T> {
    const entry = await this.#entry(id, server)
    const connection = await this.#getConnection(entry)
    try {
      const result = await operation(connection)
      entry.failures = 0
      entry.retryAt = 0
      return result
    } catch (error) {
      await this.#markFailed(entry, connection)
      throw error
    }
  }

  async #entry(id: string, server: McpServer): Promise<PoolEntry> {
    const fingerprint = JSON.stringify(server)
    const existing = this.#entries.get(id)
    if (existing?.fingerprint === fingerprint) return existing
    if (existing !== undefined) await this.#remove(id)
    const created: PoolEntry = { fingerprint, server, failures: 0, retryAt: 0 }
    this.#entries.set(id, created)
    return created
  }

  async #getConnection(entry: PoolEntry): Promise<McpConnection> {
    if (entry.connection !== undefined) return entry.connection
    if (entry.pending !== undefined) return entry.pending

    const waitMs = entry.retryAt - this.#now()
    if (waitMs > 0) await this.#sleep(waitMs)

    const pending = this.#connect(entry.server)
      .then((connection) => {
        entry.connection = connection
        entry.pending = undefined
        entry.failures = 0
        entry.retryAt = 0
        return connection
      })
      .catch((error: unknown) => {
        entry.pending = undefined
        this.#recordFailure(entry)
        throw error
      })
    entry.pending = pending
    return pending
  }

  async #markFailed(entry: PoolEntry, connection: McpConnection): Promise<void> {
    if (entry.connection === connection) entry.connection = undefined
    this.#recordFailure(entry)
    try {
      await connection.close()
    } catch {
      // The transport is already unusable. Closing is best-effort.
    }
  }

  #recordFailure(entry: PoolEntry): void {
    entry.failures = Math.min(entry.failures + 1, 31)
    const delay = Math.min(
      this.#initialBackoffMs * 2 ** Math.max(0, entry.failures - 1),
      this.#maxBackoffMs,
    )
    entry.retryAt = this.#now() + delay
  }

  async #remove(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (entry === undefined) return
    this.#entries.delete(id)
    const connection = entry.connection ?? (await entry.pending?.catch(() => undefined))
    if (connection === undefined) return
    try {
      await connection.close()
    } catch {
      // Disposal is best-effort and must not mask the caller's shutdown path.
    }
  }
}

export async function expandMcpImport(
  entry: McpImport,
  pool: McpClientPool,
): Promise<McpToolDefinition[]> {
  return expandFromConnection(entry, pool.connection(entry.id, entry.server))
}

async function expandFromConnection(
  entry: McpImport,
  connection: McpConnection,
): Promise<McpToolDefinition[]> {
  const listed = await connection.list()
  const allow = entry.allow === undefined ? null : new Set(entry.allow)
  const deny = new Set(entry.deny)
  return listed
    .filter(
      (definition) => (allow === null || allow.has(definition.name)) && !deny.has(definition.name),
    )
    .map((definition) => ({
      name: `${entry.prefix}${definition.name}`,
      description: frameDescription(
        capDescription(definition.description ?? `Call MCP tool ${definition.name}.`),
        entry.id,
        definition.name,
      ),
      parameters: definition.inputSchema,
      execute: (input) => connection.call(definition.name, input),
    }))
}

export async function createMcpExecutor(
  entry: Exclude<ToolEntry, { from: 'mcp' }>,
  pool: McpClientPool,
): Promise<(input: unknown) => Promise<unknown>> {
  const executor = entry.executor
  if (executor?.type !== 'mcp') throw new EngineError('not_ready')
  const connection = pool.connection(`tool:${entry.name}`, executor.server)
  return (input) => connection.call(executor.tool, input)
}

async function connectRemote(
  server: RemoteServer,
  fetchImpl?: typeof fetch,
): Promise<McpConnection> {
  const { Client } = await import('@modelcontextprotocol/sdk/client')
  const requestInit = { headers: server.headers }
  const transport =
    server.transport === 'http'
      ? new (
          await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
        ).StreamableHTTPClientTransport(new URL(server.url), {
          requestInit,
          ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
        })
      : new (await import('@modelcontextprotocol/sdk/client/sse.js')).SSEClientTransport(
          new URL(server.url),
          {
            requestInit,
            ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
          },
        )
  const client = new Client({ name: 'sitebot', version: '0.0.0' })
  await client.connect(transport)
  return {
    async list() {
      const result = await client.listTools()
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema as JsonSchemaObject,
      }))
    },
    async call(name, input) {
      const result = await client.callTool({
        name,
        arguments:
          typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
      })
      return capResult(result)
    },
    async ping() {
      await client.ping()
    },
    async close() {
      await transport.close()
    },
  }
}

function capDescription(description: string): string {
  return description.length <= 1024 ? description : `${description.slice(0, 1021)}...`
}

function frameDescription(description: string, serverId: string, toolName: string): string {
  return untrustedBlock({
    tag: 'mcp_tool_description',
    source: `The text below is the description of MCP tool "${toolName}" supplied by server "${serverId}".`,
    content: description,
    delimiterId: randomDelimiterId(),
  })
}

function capResult(result: unknown): unknown {
  const serialized = JSON.stringify(result)
  if (serialized.length <= 65_536) return result
  return { error: 'response_too_large', message: 'The MCP tool response exceeded 64 KB.' }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'MCP server is unavailable.'
}
