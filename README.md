# SiteBot

A reusable embeddable assistant framework for websites. Mount a server adapter and add the custom element or React integration. Applications own trusted instructions, context loading, provider configuration, and every tool definition and implementation.

SiteBot provides streaming, bounded model/tool loops, schema validation, permissions and approvals, conversation/session stores, localization, provider transports, and generic source provenance with clickable citations. English and French ship by default; add more language catalogs as needed.

```ts
import { defineConfig } from '@sitebot/config'

export default defineConfig({
  version: 1,
  name: 'Website assistant',
  backend: { provider: 'openai', model: 'application-selected-model' },
  prompt: { system: 'Help visitors using the approved application context.' },
  tools: [],
  ui: { locale: 'auto', supportedLocales: ['en', 'fr'] },
})
```

An empty registry exposes no tools. Register complete application tools with descriptions, input/output schemas, permissions/limits and exactly one handler or HTTP/module/named-MCP/client transport. Models supply only tool names and arguments. Browser tools run only application-registered handlers. Applications implement any retrieval, document loading, ingestion or product actions themselves.

`prompt.system` accepts a string or an async server resolver with verified identity, locale, request/session IDs, signal and explicitly untrusted page context. Generic server tool handlers can register application-selected evidence through `ctx.sources.register`. Sources publish only after successful validation and deadline checks.

Workspace packages: `@sitebot/config`, `@sitebot/core`, `@sitebot/server`, `@sitebot/widget`, `@sitebot/react`, and `@sitebot/cli`. Session persistence supports memory, SQLite, Redis, PostgreSQL and custom stores. The CLI provides init, validate, dev, serve and doctor.

Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, `pnpm test:security`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm size` and `pnpm check:packages`. The Next.js production fixture is checked with `node test/smoke/nextjs-build.mjs`; it builds without credentials and verifies relocated HTTP/SSE/browser behavior against synthetic loopback services. Live provider/store tests are opt-in.

See [configuration](docs/02-configuration.md), [tools](docs/05-tools.md), [sources and citations](docs/06-sources.md), [providers and limits](docs/04-providers-and-engine.md), and [security](docs/08-security.md). The [Next.js example](examples/nextjs) demonstrates normal application HTTP handlers; the [Cloudflare example](examples/cloudflare-worker) demonstrates a consumer-owned KV store.

## Migration

Remove `knowledge`, builtin executors, bulk MCP imports and `hooks.onPromptComposed`. Use application-owned loaders and handlers, exact named MCP registrations, and `prompt.system` resolvers. `onToolCall` return values are ignored. The ingest package/command and automatic browser actions have been removed. See the [configuration migration details](docs/02-configuration.md#removed-configuration).

Token/time guards evaluate between steps and may overshoot on the final call. Admission budgets have no reservations or exactly-once guarantees. Cancellation is cooperative. Ajv requires runtime code generation; dependency bundle checks do not qualify restricted edge runtimes.
