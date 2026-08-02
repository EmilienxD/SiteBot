# SiteBot MCP server example

A minimal backend developers can expose to SiteBot, Claude Desktop, or any MCP client.

## Run over stdio

```sh
pnpm --filter @sitebot/example-mcp-server start
```

Configure SiteBot with:

```yaml
tools:
  - from: mcp
    id: example
    server:
      transport: stdio
      command: node
      args: [examples/mcp-server/server.mjs]
    allow: [lookup_plan]
    prefix: example_
    readOnly: true
```

## Run over streamable HTTP

```sh
pnpm --filter @sitebot/example-mcp-server start:http
```

Use `server: { transport: http, url: http://127.0.0.1:3333/mcp }` in a Node/self-hosted development config. Production deployments should use HTTPS.
