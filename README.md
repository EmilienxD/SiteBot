# website-chatbot-template

A drop-in, fully configurable AI assistant for any website. One config file, one route handler, one script tag.

> **Status: Phase 1 — `@sitebot/config` complete.**
> The config file is real: schema, loader, `${env.*}` interpolation, `extends` merging, cross-field
> validation and a published JSON Schema. No engine yet.
> The full specification lives in [`docs/`](./docs) and is the implementation blueprint.

---

## What it is

A floating launcher button in the corner of every page. Click it, an overlay chat panel opens on top of the site. The assistant knows what page you are on, what is in the site's documentation, and can call the site's own APIs.

Everything — model, provider, system prompt, tools, chat-vs-agent, knowledge sources, theme, security — is configured in a single `chatbot.config.yaml`.

---

## Design decisions

|                   | Choice                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Config**        | YAML primary (JSON/TOML also parsed), optional `defineConfig()` TypeScript layer for inline handlers                 |
| **Backend**       | TypeScript core + thin adapters (Next.js, Express, Fastify, Hono, `fetch`); sidecar server for Python/Ruby/PHP sites |
| **Widget**        | Custom Element + Shadow DOM + Preact, ~25 KB gzip, works on any site                                                 |
| **Model layer**   | Vercel AI SDK v6 — provider registry, streaming, tool calling                                                        |
| **Wire format**   | AI SDK UI Message Stream over SSE, with custom data parts for citations, approvals, and client tools                 |
| **Knowledge**     | Four layers: static site context → live page context → embedded knowledge base → live API tools                      |
| **Chat vs Agent** | One engine, one `mode` switch. Nothing else in the codebase branches on it.                                          |

---

## Specification

Read in order. Docs 02–08 contain normative rules; every one of them should end up with a test.

| Doc                                                          | Contents                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [00 — Overview](./docs/00-overview.md)                       | Goals, non-goals, locked decisions, deployment topologies, glossary        |
| [01 — Architecture](./docs/01-architecture.md)               | Monorepo layout, package boundaries, dependency rules, request lifecycle   |
| [02 — Configuration](./docs/02-configuration.md)             | Complete config schema reference                                           |
| [03 — Protocol](./docs/03-protocol.md)                       | Endpoints, SSE parts, suspend/resume, browser JS API                       |
| [04 — Providers & Engine](./docs/04-providers-and-engine.md) | Provider registry, fallback chain, the chat/agent loop, prompt composition |
| [05 — Tools](./docs/05-tools.md)                             | Five executor kinds, MCP, client tools, approval gates                     |
| [06 — Knowledge](./docs/06-knowledge.md)                     | The four layers, ingest pipeline, vector stores, retrieval                 |
| [07 — Widget](./docs/07-widget.md)                           | UI spec, design tokens, states, accessibility, responsive                  |
| [08 — Security](./docs/08-security.md)                       | Threat model, trust boundaries, controls, deployment checklist             |
| [09 — Implementation Plan](./docs/09-implementation-plan.md) | Eleven phases with acceptance criteria                                     |

Visual reference: [`docs/example-from-ramp-website.png`](./docs/example-from-ramp-website.png)

---

## Target integration surface

```yaml
# chatbot.config.yaml
version: 1
name: Acme Assistant
mode: agent

backend:
  provider: anthropic
  model: claude-opus-5
  apiKey: ${env.ANTHROPIC_API_KEY}

prompt:
  system: You are Acme's website assistant. Be concise and accurate.

siteContext:
  company: Acme Inc
  facts: [Support hours are 9-18 CET, Monday to Friday]

knowledge:
  sources:
    - { type: sitemap, url: https://acme.com/sitemap.xml }
  store: { type: sqlite, path: ./.sitebot/index.db }

tools:
  - name: check_order_status
    description: Look up an order's status and ETA by ID.
    readOnly: true
    parameters:
      {
        type: object,
        properties: { orderId: { type: string } },
        required: [orderId],
      }
    executor: { type: http, url: 'https://api.acme.com/orders/{orderId}' }
```

```ts
// app/api/chat/route.ts
import { createNextHandler } from '@sitebot/server/next'
import config from '../../../chatbot.config.yaml'
export const { POST, GET } = createNextHandler(config)
```

```html
<script
  type="module"
  src="/sitebot.js"
  data-endpoint="/api/chat"
  data-key="pk_live_…"
></script>
```

---

## Packages

The dependency graph is strictly acyclic and layered — a package may only import from packages below it. This is enforced by ESLint, and the enforcement itself is tested in [`test/boundaries.test.ts`](./test/boundaries.test.ts).

| Layer | Package           | Role                                                       |
| ----- | ----------------- | ---------------------------------------------------------- |
| 4     | `@sitebot/cli`    | `sitebot init / validate / ingest / dev / serve / doctor`  |
| 3     | `@sitebot/server` | Thin adapters: Next, Express, Fastify, Hono, Node, `fetch` |
| 3     | `@sitebot/ingest` | Crawl → extract → chunk → embed → store (Node only)        |
| 3     | `@sitebot/widget` | The `<site-chat>` custom element (browser)                 |
| 3     | `@sitebot/react`  | `<ChatWidget />` wrapper around the element (browser)      |
| 2     | `@sitebot/core`   | The engine: providers, prompt, tools, agent loop, guards   |
| 1     | `@sitebot/config` | Schema, loader, types — importable from the browser        |

---

## Development

```bash
pnpm install
pnpm build        # turbo, topologically ordered
pnpm test         # vitest, one project per package
pnpm lint         # eslint, including the dependency-boundary rules
pnpm typecheck
pnpm size         # widget bundle budgets: 12 KB launcher, 25 KB total
```

`pnpm test:live` is a separate, opt-in suite. No test in the default pipeline makes a real provider call.

---

## Configuration

`@sitebot/config` splits along the same line as `@sitebot/core`: the schema, validators and
`toPublicConfig` are browser-safe, and the filesystem loader lives behind a Node-only subpath.

```ts
import { validateConfig, toPublicConfig } from '@sitebot/config'
import { loadConfig } from '@sitebot/config/node' // reads files, needs node:fs
```

Point your editor at the generated schema for autocomplete and inline validation:

```yaml
# yaml-language-server: $schema=./node_modules/@sitebot/config/schema/chatbot.schema.json
```

`sitebot init` writes that line for you. The file is generated from the Zod source at build time,
so it cannot drift from what the loader actually accepts.

---

## Next step

[Phase 2 — `@sitebot/core`, chat mode only](./docs/09-implementation-plan.md#phase-2--sitebotcore-chat-mode-only): the provider registry with lazy imports and install hints, the fallback chain, prompt composition, session storage, guards, and `handleChat` streaming against `MockLanguageModelV2`.
