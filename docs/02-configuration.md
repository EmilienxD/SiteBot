# Configuration

Use YAML, JSON, or TOML for declarative configuration; use `chatbot.config.ts` for trusted async instructions and inline handlers. The Node loader resolves `${env.NAME}` values, supports `${env.NAME:-default}`, and loads an `extends` chain. Tools merge by name with whole-definition replacement. Other arrays replace wholesale. Unknown keys fail validation.

```ts
import { defineConfig } from '@sitebot/config'

export default defineConfig({
  version: 1,
  name: 'Website assistant',
  backend: { provider: 'openai', model: 'application-selected-model' },
  prompt: {
    system: async ({ identity, locale, signal, untrustedPageContext }) => {
      void identity; void signal; void untrustedPageContext
      return `Help visitors using the application's approved context. Reply in ${locale}.`
    },
    systemTimeoutMs: 3000,
  },
  tools: [],
  ui: { locale: 'auto', supportedLocales: ['en', 'fr'] },
  storage: { type: 'memory' },
})
```

`prompt.system` is a nonempty string or a server resolver. Resolvers receive verified identity, resolved locale, request/session IDs, an abort signal, and explicitly untrusted page context. They run once per incoming request, including resumes, with a default 3000 ms timeout and a maximum of 10000 ms. Results are request-local. Loading failures fail closed with sanitized errors. Page and tool content cannot rewrite trusted instructions.

`tools: []` is genuinely empty. Each application tool requires a name, description, complete input `parameters` and `outputSchema`, and exactly one inline `execute` handler or `executor`. Set `readOnly`, `scope`, approval requirements, timeout and optional session limits explicitly for the intended permission boundary. Supported transports are HTTP, module, named MCP, and client. See [tools](05-tools.md).

`mode: chat` permits only read-only tools. `mode: agent` supports writable tools, approval gates and resumable client calls. Agent mode needs session storage. Available session backends are none, memory, SQLite, Redis, PostgreSQL and custom; PostgreSQL/Redis/SQLite remain session infrastructure.

Backend configuration, retries, fallbacks, per-invocation `timeoutMs`, prompt caching, history limits, telemetry, security, UI and locale catalogs remain configurable. The generated [complete reference](../apps/docs/reference/configuration.md) and published JSON Schema list fields and defaults.

## Removed configuration

Remove `knowledge` entirely: SiteBot no longer loads or indexes application content. Remove builtin executors and register application implementations. Bulk MCP imports (`from: mcp`, allow/deny/prefix expansion) are removed; register each remote name with application descriptions and input/output schemas. `hooks.onPromptComposed` is removed; migrate instruction loading to `prompt.system`. `onToolCall` observes admitted calls and cannot override results. `ui.behaviour.navigateAllowlist` and public capability `routes` were removed with automatic browser actions. Application handlers own action restrictions.
