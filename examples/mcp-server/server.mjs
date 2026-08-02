import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

function createExampleServer() {
  const server = new McpServer({ name: 'sitebot-example', version: '1.0.0' })
  server.registerTool(
    'lookup_plan',
    {
      description: 'Look up a public subscription plan. Use when a visitor asks about plan limits.',
      inputSchema: { plan: z.enum(['starter', 'pro']) },
    },
    ({ plan }) => ({
      content: [
        {
          type: 'text',
          text:
            plan === 'starter'
              ? 'Starter includes 1,000 conversations per month.'
              : 'Pro includes 10,000 conversations per month and priority support.',
        },
      ],
    }),
  )
  return server
}

if (process.argv.includes('--http')) {
  const httpServer = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end('Not found')
      return
    }
    const mcp = createExampleServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    void mcp
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .finally(() => mcp.close())
  })
  httpServer.listen(3333, '127.0.0.1', () => {
    process.stderr.write('MCP HTTP server listening at http://127.0.0.1:3333/mcp\n')
  })
} else {
  await createExampleServer().connect(new StdioServerTransport())
}
