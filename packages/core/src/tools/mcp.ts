import type { McpImport, ToolEntry } from '@sitebot/config'
import { EngineError } from '../stream/errors.js'
import type { JsonSchemaObject } from './schema.js'

type RemoteServer = Extract<McpImport['server'], { transport: 'http' | 'sse' }>
export type StdioServer = Extract<McpImport['server'], { transport: 'stdio' }>

export interface McpToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaObject
  execute(input: unknown): Promise<unknown>
}

export interface McpConnection {
  list(): Promise<Array<{ name: string; description?: string; inputSchema: JsonSchemaObject }>>
  call(name: string, input: unknown): Promise<unknown>
}

export type StdioMcpConnector = (server: StdioServer) => Promise<McpConnection>

const connections = new Map<string, Promise<McpConnection>>()

export async function expandMcpImport(
  entry: McpImport,
  fetchImpl?: typeof fetch,
  connectStdio?: StdioMcpConnector,
): Promise<McpToolDefinition[]> {
  if (entry.server.transport === 'stdio') {
    if (connectStdio === undefined) throw new EngineError('not_ready', { message: `MCP server "${entry.id}" uses stdio; construct it through @sitebot/core/node.` })
    return expandFromConnection(entry, await connectStdio(entry.server))
  }
  return expandFromConnection(entry, await remoteConnection(entry.server, fetchImpl))
}

async function expandFromConnection(entry: McpImport, connection: McpConnection): Promise<McpToolDefinition[]> {
  const listed = await connection.list()
  const allow = entry.allow === undefined ? null : new Set(entry.allow)
  const deny = new Set(entry.deny)
  return listed
    .filter((definition) => (allow === null || allow.has(definition.name)) && !deny.has(definition.name))
    .map((definition) => ({
      name: `${entry.prefix}${definition.name}`,
      description: capDescription(definition.description ?? `Call MCP tool ${definition.name}.`),
      parameters: definition.inputSchema,
      execute: (input) => connection.call(definition.name, input),
    }))
}

export async function createMcpExecutor(
  entry: Exclude<ToolEntry, { from: 'mcp' }>,
  fetchImpl?: typeof fetch,
  connectStdio?: StdioMcpConnector,
): Promise<(input: unknown) => Promise<unknown>> {
  const executor = entry.executor
  if (executor?.type !== 'mcp') throw new EngineError('not_ready')
  if (executor.server.transport === 'stdio') {
    if (connectStdio === undefined) throw new EngineError('not_ready', { message: `MCP tool "${entry.name}" uses stdio; construct it through @sitebot/core/node.` })
    const connection = await connectStdio(executor.server)
    return (input) => connection.call(executor.tool, input)
  }
  const connection = await remoteConnection(executor.server, fetchImpl)
  return (input) => connection.call(executor.tool, input)
}

async function remoteConnection(
  server: RemoteServer,
  fetchImpl?: typeof fetch,
): Promise<McpConnection> {
  const key = JSON.stringify(server)
  let pending = connections.get(key)
  if (pending === undefined) {
    pending = connectRemote(server, fetchImpl).catch((error: unknown) => {
      connections.delete(key)
      throw error
    })
    connections.set(key, pending)
  }
  return pending
}

async function connectRemote(
  server: RemoteServer,
  fetchImpl?: typeof fetch,
): Promise<McpConnection> {
  const { Client } = await import('@modelcontextprotocol/sdk/client')
  const requestInit = { headers: server.headers }
  const transport = server.transport === 'http'
    ? new (await import('@modelcontextprotocol/sdk/client/streamableHttp.js')).StreamableHTTPClientTransport(new URL(server.url), {
        requestInit,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      })
    : new (await import('@modelcontextprotocol/sdk/client/sse.js')).SSEClientTransport(new URL(server.url), {
        requestInit,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      })
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
        arguments: typeof input === 'object' && input !== null ? input as Record<string, unknown> : {},
      })
      return capResult(result)
    },
  }
}

function capDescription(description: string): string {
  return description.length <= 1024 ? description : `${description.slice(0, 1021)}...`
}

function capResult(result: unknown): unknown {
  const serialized = JSON.stringify(result)
  if (serialized.length <= 65_536) return result
  return { error: 'response_too_large', message: 'The MCP tool response exceeded 64 KB.' }
}
