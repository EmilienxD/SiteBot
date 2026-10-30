import type { McpConnection, StdioMcpConnector } from '../tools/mcp.js'

/**
 * Opens one stdio transport. Pooling and reconnect backoff are owned by the
 * edge-safe McpClientPool so all three transports share identical lifecycle
 * semantics.
 */
export const connectStdioMcp: StdioMcpConnector = async (server) => {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ])
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
  })
  const client = new Client({ name: 'sitebot', version: '0.0.0' })
  await client.connect(transport)
  return {
    async list() {
      const result = await client.listTools()
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema as never,
      }))
    },
    async call(name, input, signal) {
      const result = await client.callTool(
        {
          name,
          arguments:
            typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
        },
        undefined,
        { signal },
      )
      const serialized = JSON.stringify(result)
      return serialized.length <= 65_536
        ? result
        : { error: 'response_too_large', message: 'The MCP tool response exceeded 64 KB.' }
    },
    async ping() {
      await client.ping()
    },
    async close() {
      await transport.close()
    },
  } satisfies McpConnection
}
