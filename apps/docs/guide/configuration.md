# Configuration

SiteBot validates YAML, JSON, TOML and TypeScript configuration. Use server-only TypeScript for inline application handlers and `prompt.system` resolvers. Unknown or removed options fail clearly.

```yaml
version: 1
name: Website assistant
backend: { provider: openai, model: gpt-5-mini }
prompt: { system: Help visitors using the approved application context. }
tools: []
ui: { locale: auto, supportedLocales: [en, fr] }
```

An empty registry exposes no tools. The application owns every tool definition and implementation, all trusted instructions, context loading, and provider choice. A complete tool defines its name, description, input/output schemas, exactly one handler or transport, permissions and limits. HTTP, module, explicit named MCP and registered client handlers are supported.

Use `${env.NAME}` for secrets. UI configuration is public and must contain no secrets. With `extends`, objects deep-merge, tools replace by name, and other arrays replace wholesale. Run `sitebot validate` to inspect resolved configuration safely.

`prompt.system` accepts a string or async server resolver with verified identity, locale, request/session IDs, signal and explicitly untrusted page context. The resolver is bounded and request-local. `onPromptComposed`, builtin tools, bulk MCP imports, knowledge configuration and the ingest command have been removed. `onToolCall` return values are ignored; handlers provide results.

See the [generated reference](../reference/configuration.md), [multilingual guide](multilingual.md), and application-owned [recipes](../recipes/index.md).
