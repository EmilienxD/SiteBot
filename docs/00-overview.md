# 00 — Overview

> **Status:** Approved design. This document set is the implementation blueprint.
> **Package scope:** `@sitebot/*` (placeholder — a single find-and-replace away from any other name).

---

## 1. What we are building

A **drop-in AI assistant for websites**, delivered as a template. A developer:

1. Copies the template (or installs the packages).
2. Edits **one configuration file**.
3. Mounts one route handler on their backend.
4. Adds one `<script>` tag to their frontend.

They get a floating launcher button in the bottom-right of every page. Clicking it opens an overlay panel on top of the site — the reference visual is the Chili Piper widget on ramp.com (`docs/example-from-ramp-website.png`).

The assistant is configured entirely from the config file: which model answers, what its system prompt is, what tools it can call, whether it is a single-turn chat or a multi-step agent, and how it learns about the website it lives on.

---

## 2. Locked decisions

These four were decided in the design session and everything downstream assumes them.

| #   | Decision             | Choice                                                                                                               | Consequence                                                                                                                                      |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Configuration format | **YAML primary**, JSON/TOML parsed by the same loader, optional `chatbot.config.ts` escape hatch that merges over it | Declarative file is the documented product. TS exists only for inline JS handlers and hooks.                                                     |
| D2  | Backend runtime      | **Node/TypeScript core + thin adapters** (Next.js, Express, Fastify, Hono, generic `fetch`)                          | Non-JS sites (Django/Rails/PHP/Laravel) run `sitebot serve` as a sidecar service. No second implementation.                                      |
| D3  | Widget delivery      | **Custom Element + Shadow DOM + Preact**, shipped as `<script>` tag (IIFE) and ESM                                   | ~20 KB gzip target. Full CSS isolation. Direct DOM access enables page-context capture and client-side tools. Optional `isolation: iframe` mode. |
| D4  | Knowledge layer      | **Full 4-layer pipeline in v1**; `memory` and `sqlite-vec` stores default, `pgvector`/`upstash` adapters             | `npx sitebot init` produces a genuinely knowledgeable bot with zero external infrastructure.                                                     |

### Derived decisions (not separately negotiated, but binding)

| #   | Decision                                                                         | Rationale                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D5  | **Vercel AI SDK v6** is the provider/streaming substrate                         | Unified `streamText`, tool calling, provider registry, multi-step loops, documented SSE wire format. We wrap it; we do not reimplement it.                  |
| D6  | Wire protocol is the **AI SDK UI Message Stream** (SSE)                          | Text deltas, reasoning, tool-call/result parts, sources, errors, message metadata, and typed _custom data parts_ all come free. Never invent a wire format. |
| D7  | **One engine**, `mode: chat \| agent` is a policy switch                         | Two runtimes would diverge. Same loop, different step/tool/retrieval policy.                                                                                |
| D8  | Tools have **five executor kinds**: `http`, `mcp`, `module`, `builtin`, `client` | Covers ~100% of real needs with zero code for the first two and last two.                                                                                   |
| D9  | Zod is the single schema source                                                  | Emits TS types _and_ a published JSON Schema for editor autocomplete on the YAML file.                                                                      |

---

## 3. Goals

**G1 — One file configures everything.** Provider, model, prompt, tools, mode, knowledge sources, UI, security, budgets. No code required for the common case.

**G2 — Works on any website.** A `<script>` tag on plain HTML must work identically to a React import in Next.js. WordPress, Astro, Rails, Hugo, Webflow — all in scope.

**G3 — Provider-agnostic.** Anthropic, OpenAI, Google, any OpenAI-compatible gateway, or local Ollama, selected by two config lines, with an automatic fallback chain.

**G4 — Actually knows the website.** Not a generic chatbot with a custom prompt. It knows what page you are on, what is on that page, and what is in the docs — see [`06-knowledge.md`](./06-knowledge.md).

**G5 — Can act, safely.** Agent mode calls real APIs. Side-effecting tools are gated behind an explicit user-approval card rendered in the panel.

**G6 — Deployable on a public marketing site.** Rate limits, origin allowlists, hard token/USD budgets, and an explicit prompt-injection posture are v1 features, not v2 hardening.

**G7 — Zero-infra first run.** `npx sitebot init && npx sitebot dev` must produce a working, knowledgeable assistant with nothing but an API key.

---

## 4. Non-goals

Explicitly out of scope. Recording these prevents scope drift in later sessions.

| Not building                                       | Why                                                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A hosted SaaS control plane, dashboard, or billing | This is a self-hosted template. The developer owns their infra and keys.                                                          |
| A human-agent inbox / live-chat console            | We ship a `handoff_to_human` **tool** that hands off to Intercom/Crisp/Zendesk/a webhook. We do not build the agent-side console. |
| Voice / realtime audio                             | Deferred. The protocol choice (D6) does not preclude it later.                                                                    |
| A CRM, ticketing system, or scheduler              | Integrated via `http`/`mcp` tools, never built in.                                                                                |
| Fine-tuning or model training                      | Retrieval and prompting only.                                                                                                     |
| A second Python/Go server implementation           | D2. Non-JS backends use the sidecar.                                                                                              |
| Multi-tenant key isolation                         | One deployment serves one site. Multi-tenancy is the developer's problem.                                                         |
| Analytics dashboards                               | We emit structured events + OpenTelemetry spans. Visualisation is theirs.                                                         |

---

## 5. Glossary

| Term               | Meaning                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Host page**      | The developer's website that embeds the widget.                                                             |
| **Widget**         | The custom element (`<site-chat>`) — launcher button + overlay panel.                                       |
| **Panel**          | The overlay chat surface that opens on launcher click.                                                      |
| **Engine**         | `@sitebot/core`'s runtime: resolves config → builds a model call → runs the loop → emits a stream.          |
| **Executor**       | The mechanism that actually runs a tool (`http`, `mcp`, `module`, `builtin`, `client`).                     |
| **Client tool**    | A tool whose executor runs **in the browser**, with DOM access.                                             |
| **Page context**   | Live facts about the page the user is currently viewing, captured by the widget and sent with each request. |
| **Site context**   | Static facts about the site, declared in config, always in the system prompt.                               |
| **Knowledge base** | The embedded, indexed corpus produced by `sitebot ingest`.                                                  |
| **Data part**      | A typed custom message part streamed over SSE to drive widget UI (citations, approval cards, navigation).   |
| **Approval gate**  | The confirm-card flow that blocks a side-effecting tool until the user consents.                            |

---

## 6. Deployment topologies

The developer picks one. All three are served by the same `@sitebot/core` and differ only in the adapter used.

### T1 — Same-app (recommended default)

The chat route lives inside the developer's existing JS app.

```
┌─────────────────────────────────────────┐
│  Next.js / Remix / Nuxt / SvelteKit app │
│                                         │
│  app/api/chat/route.ts                  │
│    export const { POST, GET } =         │
│      createNextHandler(config)          │
│                                         │
│  app/layout.tsx                         │
│    <script src="/sitebot.js" ...>       │
└─────────────────────────────────────────┘
```

Simplest. Same origin, so no CORS. Session JWT minting is trivial because auth already lives here.

### T2 — Sidecar service (for non-JS backends)

```
┌──────────────────┐        ┌────────────────────────┐
│ Django / Rails / │        │  sitebot serve         │
│ Laravel / PHP    │        │  (Node, Hono)          │
│                  │        │                        │
│  <script src=    │───────▶│  POST /api/chat        │
│   "https://chat. │  CORS  │  reads chatbot.config  │
│   acme.com/..."> │        │  .yaml                 │
└──────────────────┘        └────────────────────────┘
        │                             ▲
        │  mints session JWT          │
        └─────────────────────────────┘
              shared signing secret
```

The host backend mints a signed JWT identifying the logged-in user and passes it to `SiteBot.identify(jwt)`. The sidecar verifies it with the shared secret, so tools get trustworthy identity without the sidecar owning auth.

### T3 — Edge

```
Cloudflare Worker / Vercel Edge / Deno Deploy
  export default { fetch: createFetchHandler(config) }
```

Constraints: no stdio MCP servers, no local sqlite-vec (use `pgvector` or `upstash`), no filesystem knowledge sources at runtime (index must be built at deploy time and shipped or hosted).

---

## 7. Integration surface (what the developer actually writes)

**Backend — one file:**

```ts
// app/api/chat/route.ts
import { createNextHandler } from '@sitebot/server/next'
import config from '../../../chatbot.config.yaml'

export const { POST, GET } = createNextHandler(config)
```

**Frontend — one tag:**

```html
<script
  src="https://cdn.jsdelivr.net/npm/@sitebot/widget/dist/sitebot.js"
  data-endpoint="/api/chat"
  data-key="pk_live_a1b2c3"
  defer
></script>
```

**Config — one file:** `chatbot.config.yaml`. Full reference in [`02-configuration.md`](./02-configuration.md).

That is the entire required surface. Everything else is optional.

---

## 8. Document map

| Doc                                                          | Contents                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`00-overview.md`](./00-overview.md)                         | This file. Goals, decisions, topologies, glossary.                        |
| [`01-architecture.md`](./01-architecture.md)                 | Monorepo layout, package boundaries, dependency rules, request lifecycle. |
| [`02-configuration.md`](./02-configuration.md)               | Complete config schema reference.                                         |
| [`03-protocol.md`](./03-protocol.md)                         | HTTP endpoints, SSE parts, client JS API, error taxonomy.                 |
| [`04-providers-and-engine.md`](./04-providers-and-engine.md) | Provider registry, fallback, the chat/agent loop.                         |
| [`05-tools.md`](./05-tools.md)                               | Executor kinds, MCP, client tools, approval flow, builtin catalog.        |
| [`06-knowledge.md`](./06-knowledge.md)                       | The four knowledge layers, ingest pipeline, vector stores, retrieval.     |
| [`07-widget.md`](./07-widget.md)                             | Widget UI spec, design tokens, states, accessibility, theming.            |
| [`08-security.md`](./08-security.md)                         | Threat model, trust boundaries, controls.                                 |
| [`09-implementation-plan.md`](./09-implementation-plan.md)   | Phased build order with acceptance criteria.                              |
