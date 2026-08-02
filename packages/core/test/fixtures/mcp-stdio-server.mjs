import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'sitebot-test-stdio', version: '1.0.0' })

server.registerTool(
  'get_time',
  {
    description: 'Get the current time in a requested timezone.',
    inputSchema: { timezone: z.string().default('UTC') },
  },
  ({ timezone }) => ({
    content: [{ type: 'text', text: `${timezone}: ${new Date(0).toISOString()}` }],
  }),
)

await server.connect(new StdioServerTransport())
