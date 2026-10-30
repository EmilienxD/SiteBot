# @sitebot/core

The reusable assistant engine: providers, bounded model loop, prompt resolution, validated application tools, approvals, session history, generic sources/citations, security guards, telemetry, and streaming.

Applications own instructions, provider configuration, context loading, tool definitions and implementations. `tools: []` exposes no tools. Use `ToolHandler` and `ToolContext` for inline implementations; use HTTP, module, named MCP or registered client transports where appropriate. `ctx.sources.register` stages application-selected evidence until successful output validation and deadline checks.

`prompt.system` accepts a string or async server resolver. `onToolCall` is observational; results always come from the registered handler. Unknown and unauthorized calls never execute. Node session stores, hardened fetching and stdio MCP live in `@sitebot/core/node`.

See [tools](../../docs/05-tools.md), [sources](../../docs/06-sources.md), and [providers and engine](../../docs/04-providers-and-engine.md).
