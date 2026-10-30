# SiteBot MCP server example

A minimal backend developers can expose to SiteBot, Claude Desktop, or any MCP client.

## Run over stdio

```sh
pnpm --filter @sitebot/example-mcp-server start
```

Configure SiteBot with:

## Run over streamable HTTP

```sh
pnpm --filter @sitebot/example-mcp-server start:http
```

Use `server: { transport: http, url: http://127.0.0.1:3333/mcp }` in a Node/self-hosted development config. Production deployments should use HTTPS.

Applications own context loading and every tool implementation. Use complete explicit handlers or transports; an empty registry exposes no tools. See [the tool contract](https://github.com/EmilienxD/SiteBot/blob/main/docs/05-tools.md).
