import type { McpConnection, StdioMcpConnector } from '../tools/mcp.js'

const connections = new Map<string, Promise<McpConnection>>()

export const connectStdioMcp: StdioMcpConnector = async (server) => {
  const key = JSON.stringify(server)
  let pending = connections.get(key)
  if (pending === undefined) {
    pending = connect(server).catch((error: unknown) => {
      connections.delete(key)
      throw error
    })
    connections.set(key, pending)
  }
  return pending
}

async function connect(server: Parameters<StdioMcpConnector>[0]): Promise<McpConnection> {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ])
  const client = new Client({ name: 'sitebot', version: '0.0.0' })
  await client.connect(new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
  }))
  return {
    async list() {
      const result = await client.listTools()
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema as never,
      }))
    },
    async call(name, input) {
      const result = await client.callTool({
        name,
        arguments: typeof input === 'object' && input !== null ? input as Record<string, unknown> : {},
      })
      const serialized = JSON.stringify(result)
      return serialized.length <= 65_536
        ? result
        : { error: 'response_too_large', message: 'The MCP tool response exceeded 64 KB.' }
    },
  }
}
