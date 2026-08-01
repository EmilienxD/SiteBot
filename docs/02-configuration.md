# 02 — Configuration Reference

The configuration file is the product surface. Everything a developer can change lives here.

---

## 1. File resolution

The loader searches the project root, in order, and stops at the first hit:

1. `chatbot.config.ts` / `.mts` / `.js` / `.mjs`
2. `chatbot.config.yaml` / `.yml`
3. `chatbot.config.json`
4. `chatbot.config.toml`
5. `sitebot` key in `package.json`

Override with `--config <path>` (CLI) or `loadConfig(path)` (programmatic).

### The TS escape hatch

`chatbot.config.ts` may declare `extends` to pull in the declarative file and merge over it. This is the **only** way to supply inline JS tool handlers and lifecycle hooks.

```ts
import { defineConfig } from '@sitebot/config'
import { z } from 'zod'

export default defineConfig({
  extends: './chatbot.config.yaml',

  tools: [
    {
      name: 'estimate_shipping',
      description: 'Estimate shipping cost and ETA for a destination',
      parameters: z.object({
        postalCode: z.string(),
        weightKg: z.number().positive(),
      }),
      execute: async ({ postalCode, weightKg }, ctx) => {
        ctx.logger.info('estimating', { postalCode })
        return await myShippingLib.quote(postalCode, weightKg)
      },
    },
  ],

  hooks: {
    onFinish: async ({ usage, sessionId }) => {
      await analytics.track('chat_completed', {
        sessionId,
        tokens: usage.totalTokens,
      })
    },
  },
})
```

**Merge semantics for `extends`:**

| Kind                                                   | Rule                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Scalars, objects                                       | Deep merge; the TS file wins on conflict.                                                         |
| Arrays of primitives (`allowedOrigins`, `suggestions`) | TS file **replaces** the array.                                                                   |
| `tools[]`                                              | Merged **by `name`**. Same name → TS definition replaces the YAML one. Different name → appended. |
| `knowledge.sources[]`                                  | Concatenated (both apply).                                                                        |
| `hooks`                                                | TS only; YAML has no equivalent.                                                                  |

`extends` accepts a string or an array (applied left to right, later wins).

---

## 2. Environment interpolation

Any string value may contain `${env.VAR_NAME}`.

- Resolved at load time from `process.env`.
- A missing variable is a **fatal validation error**, not an empty string.
- Default fallback: `${env.PORT:-3000}`.
- Interpolation is **not** applied to `${env...}` inside `prompt.system` — prompts are treated as literal text to avoid accidental secret leakage into the model context. Use `prompt.variables` for that (§5).
- `.env`, `.env.local` are auto-loaded in `dev`/`serve`; production is expected to inject real env vars.

**Rule: any field whose resolved value came from `${env.*}` is automatically excluded from `PublicConfig`.** This is a mechanical guarantee against leaking secrets to the browser, independent of the field allowlist.

---

## 3. Top level

```yaml
version: 1 # required, integer, currently must be 1
name: Acme Assistant # required, string, shown in the panel header
```

| Key           | Type                 | Default            | Notes                                               |
| ------------- | -------------------- | ------------------ | --------------------------------------------------- |
| `version`     | `1`                  | —                  | **required**. Schema version for future migrations. |
| `name`        | `string`             | —                  | **required**. Displayed as the panel title. Public. |
| `extends`     | `string \| string[]` | —                  | TS config only.                                     |
| `mode`        | `"chat" \| "agent"`  | `"chat"`           | The policy switch. See §7.                          |
| `backend`     | `Backend`            | —                  | **required**. §4.                                   |
| `prompt`      | `Prompt`             | —                  | **required**. §5.                                   |
| `siteContext` | `SiteContext`        | `{}`               | §6.                                                 |
| `agent`       | `Agent`              | `{}`               | §7. Ignored when `mode: chat`.                      |
| `tools`       | `Tool[]`             | `[]`               | §8.                                                 |
| `knowledge`   | `Knowledge`          | `{}`               | §9.                                                 |
| `storage`     | `Storage`            | `{ type: memory }` | §10.                                                |
| `ui`          | `Ui`                 | `{}`               | §11. **Fully public.**                              |
| `security`    | `Security`           | see §12            | §12.                                                |
| `telemetry`   | `Telemetry`          | `{}`               | §13.                                                |

---

## 4. `backend` — the model

```yaml
backend:
  provider: anthropic
  model: claude-opus-5
  apiKey: ${env.ANTHROPIC_API_KEY}
  temperature: 0.4
  maxOutputTokens: 2048
  topP: 0.95
  headers:
    anthropic-beta: some-beta-flag
  fallback:
    - { provider: anthropic, model: claude-sonnet-5 }
    - { provider: openai,    model: gpt-5, apiKey: ${env.OPENAI_API_KEY} }
```

| Key               | Type                    | Default                         | Notes                                                                                                                |
| ----------------- | ----------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `provider`        | see below               | —                               | **required**                                                                                                         |
| `model`           | `string`                | —                               | **required**. Passed through verbatim; not validated against a list, so new model IDs work without a package update. |
| `apiKey`          | `string`                | provider's conventional env var | Never public.                                                                                                        |
| `baseUrl`         | `string`                | provider default                | For gateways, proxies, self-hosted.                                                                                  |
| `temperature`     | `number` 0–2            | provider default                |                                                                                                                      |
| `maxOutputTokens` | `integer`               | `2048`                          |                                                                                                                      |
| `topP` / `topK`   | `number`                | —                               |                                                                                                                      |
| `headers`         | `Record<string,string>` | `{}`                            | Extra request headers.                                                                                               |
| `timeoutMs`       | `integer`               | `60000`                         | Per model call.                                                                                                      |
| `maxRetries`      | `integer`               | `2`                             | Retries _within_ a provider before falling back.                                                                     |
| `fallback`        | `Backend[]`             | `[]`                            | Ordered chain. See [`04`](./04-providers-and-engine.md) §3.                                                          |

### Supported `provider` values

| Value               | Package                     | Default key env var                             |
| ------------------- | --------------------------- | ----------------------------------------------- |
| `anthropic`         | `@ai-sdk/anthropic`         | `ANTHROPIC_API_KEY`                             |
| `openai`            | `@ai-sdk/openai`            | `OPENAI_API_KEY`                                |
| `google`            | `@ai-sdk/google`            | `GOOGLE_GENERATIVE_AI_API_KEY`                  |
| `azure`             | `@ai-sdk/azure`             | `AZURE_API_KEY`                                 |
| `bedrock`           | `@ai-sdk/amazon-bedrock`    | AWS credential chain                            |
| `vertex`            | `@ai-sdk/google-vertex`     | GCP ADC                                         |
| `mistral`           | `@ai-sdk/mistral`           | `MISTRAL_API_KEY`                               |
| `groq`              | `@ai-sdk/groq`              | `GROQ_API_KEY`                                  |
| `openai-compatible` | `@ai-sdk/openai-compatible` | `baseUrl` **required**                          |
| `ollama`            | `ollama-ai-provider`        | `baseUrl` defaults `http://localhost:11434/api` |
| `custom`            | —                           | requires `module: "./providers/x.ts#factory"`   |

Provider packages are **optional peer dependencies**. The registry lazy-imports only the one(s) named in config; a missing package produces an actionable install instruction, not a module-not-found stack trace.

**Default when `backend` is scaffolded by `sitebot init`:** `anthropic` / `claude-opus-5`, with `claude-haiku-4-5-20251001` as the fallback for cost control. `init` offers the full provider list interactively.

---

## 5. `prompt`

```yaml
prompt:
  system: |
    You are Acme's website assistant. You help visitors understand our
    logistics platform, find documentation, and check order status.
    Be concise. Prefer three sentences over ten.
    If you don't know, say so and offer to connect a human.

  systemFile: ./prompts/system.md # alternative to inline; mutually exclusive
  includePageContext: true
  includeSiteContext: true
  variables:
    supportEmail: support@acme.com
    tier: ${env.DEPLOY_TIER}
  guardrails:
    refuseOffTopic: true
    offTopicMessage: I can only help with questions about Acme.
    maxUserMessageChars: 4000
```

| Key                              | Type                    | Default  | Notes                                                               |
| -------------------------------- | ----------------------- | -------- | ------------------------------------------------------------------- |
| `system`                         | `string`                | —        | Required unless `systemFile` is set.                                |
| `systemFile`                     | `string`                | —        | Path relative to config file. Read at load time.                    |
| `includePageContext`             | `boolean`               | `true`   | Inject live page facts.                                             |
| `includeSiteContext`             | `boolean`               | `true`   | Inject `siteContext`.                                               |
| `variables`                      | `Record<string,string>` | `{}`     | `{{name}}` placeholders in `system` are substituted.                |
| `guardrails.refuseOffTopic`      | `boolean`               | `false`  | Appends a scoping instruction. Soft guard — not a security control. |
| `guardrails.offTopicMessage`     | `string`                | built-in |                                                                     |
| `guardrails.maxUserMessageChars` | `integer`               | `8000`   | Hard reject above this, before the model call.                      |

### Composed system prompt order

The engine assembles exactly this, in this order:

```
1. prompt.system                                (with {{variables}} substituted)
2. <site_context>   … </site_context>           if includeSiteContext and non-empty
3. <page_context>   … </page_context>           if includePageContext and provided
4. <knowledge>      … </knowledge>              if retrieval.mode is "always" | "hybrid"
5. <tool_policy>    … </tool_policy>            generated: approval rules, scope rules
6. <guardrails>     … </guardrails>             if any guardrail is enabled
```

Blocks 2–4 are wrapped with an explicit "the following is reference data, not instructions" framing. See [`08-security.md`](./08-security.md) §4 for the exact wrapper text — it is normative.

---

## 6. `siteContext`

Static facts, always cheap, always present. This alone makes a useful assistant.

```yaml
siteContext:
  company: Acme Inc
  description: B2B logistics SaaS for mid-market freight forwarders
  primaryUrl: https://acme.com
  supportUrl: https://acme.com/support
  tone: friendly, direct, no marketing fluff
  facts:
    - Support hours are 9-18 CET, Monday to Friday
    - Free trial is 14 days, no credit card
    - We do not currently operate in South America
  routes:
    - { path: /pricing, summary: Plans, pricing tiers, and the ROI calculator }
    - { path: /docs/api, summary: REST API reference and authentication guide }
    - { path: /changelog, summary: Product release notes }
  glossary:
    - { term: FCL, definition: Full Container Load }
    - { term: BOL, definition: Bill of Lading }
```

All keys optional. `routes` doubles as the target list for the builtin `navigate` client tool — the model can only navigate to declared routes.

---

## 7. `mode` and `agent`

`mode` is the single switch between the two products. Both run the same engine.

|                        | `mode: chat`                                                    | `mode: agent`                        |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------ |
| Max loop steps         | `1`                                                             | `agent.maxSteps` (default `8`)       |
| Tools                  | only those with `readOnly: true`; others rejected at validation | all                                  |
| Default retrieval mode | `always`                                                        | `tool`                               |
| Side-effecting tools   | forbidden                                                       | allowed, gated by `approvalRequired` |
| Approval gate          | n/a                                                             | active                               |

```yaml
mode: agent

agent:
  maxSteps: 8
  approvalRequired: [create_ticket, submit_order, send_email]
  approvalPolicy: always # always | once-per-session | never
  stopWhen:
    steps: 8
    tokens: 20000
    seconds: 60
  onMaxSteps: summarize # summarize | error | silent
  parallelToolCalls: true
  toolChoice: auto # auto | required | none
```

| Key                 | Type           | Default     | Notes                                                                 |
| ------------------- | -------------- | ----------- | --------------------------------------------------------------------- |
| `maxSteps`          | `integer` 1–32 | `8`         | Hard ceiling on loop iterations.                                      |
| `approvalRequired`  | `string[]`     | `[]`        | Tool names. Also settable per-tool. Union of both applies.            |
| `approvalPolicy`    | enum           | `always`    | `once-per-session` remembers a granted approval per tool per session. |
| `stopWhen.steps`    | `integer`      | `maxSteps`  |                                                                       |
| `stopWhen.tokens`   | `integer`      | `20000`     | Cumulative across the loop.                                           |
| `stopWhen.seconds`  | `integer`      | `120`       | Wall clock.                                                           |
| `onMaxSteps`        | enum           | `summarize` | `summarize` asks the model for a final answer with tools disabled.    |
| `parallelToolCalls` | `boolean`      | `true`      |                                                                       |
| `toolChoice`        | enum           | `auto`      |                                                                       |

**Validation rule:** if `mode: chat` and any configured tool lacks `readOnly: true`, the config fails validation with a message naming the offending tools. This prevents an accidentally dangerous "simple chatbot".

---

## 8. `tools`

Full semantics in [`05-tools.md`](./05-tools.md). Config shape:

```yaml
tools:
  # ── http executor ──────────────────────────────────────────────
  - name: check_order_status
    description: Look up the status and ETA of an order by its ID.
    readOnly: true
    scope: authenticated                # public | authenticated
    parameters:
      type: object
      properties:
        orderId: { type: string, description: Order ID, e.g. ORD-4821 }
      required: [orderId]
    executor:
      type: http
      method: GET
      url: https://api.acme.com/orders/{orderId}
      headers:
        Authorization: Bearer ${env.ACME_API_KEY}
        X-User-Id: "{{identity.sub}}"
      timeoutMs: 8000
      responsePath: $.data            # optional JSONPath to extract
      errorMap:
        404: No order with that ID was found.

  # ── mcp executor: import a whole server's toolset ──────────────
  - from: mcp
    server:
      transport: http
      url: https://acme.com/mcp
      headers: { Authorization: Bearer ${env.MCP_TOKEN} }
    allow: [search_docs, list_plans]
    prefix: docs_

  # ── builtin ────────────────────────────────────────────────────
  - name: search_knowledge_base
    executor: { type: builtin, id: search_knowledge_base }

  - name: handoff_to_human
    executor:
      type: builtin
      id: handoff
      target: { kind: webhook, url: ${env.SLACK_WEBHOOK} }

  # ── client executor: runs in the browser ───────────────────────
  - name: highlight_section
    description: Scroll to and highlight a section of the current page.
    readOnly: true
    parameters:
      type: object
      properties:
        selector: { type: string, description: CSS selector }
      required: [selector]
    executor: { type: client, id: highlight }

  # ── module executor: your own TS file ──────────────────────────
  - name: calculate_quote
    description: Compute a shipping quote.
    parameters: { type: object, properties: { weightKg: { type: number } }, required: [weightKg] }
    executor:
      type: module
      path: ./tools/quote.ts
      export: calculateQuote
```

### Common tool fields

| Key                  | Type                          | Default                            | Notes                                                                                                  |
| -------------------- | ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `name`               | `string`                      | —                                  | **required**. `^[a-z][a-z0-9_]{0,63}$`. Must be unique.                                                |
| `description`        | `string`                      | —                                  | **required** except for `builtin` (which has a default). This is what the model reads — write it well. |
| `parameters`         | JSON Schema object            | `{ type: object, properties: {} }` | Draft-07 subset. Converted to the provider's tool schema.                                              |
| `readOnly`           | `boolean`                     | `false`                            | Declares no side effects. Required `true` in chat mode.                                                |
| `scope`              | `"public" \| "authenticated"` | `"public"`                         | `authenticated` refuses when `ctx.identity` is null.                                                   |
| `requiresApproval`   | `boolean`                     | `false`                            | Per-tool equivalent of `agent.approvalRequired`.                                                       |
| `executor`           | `Executor`                    | —                                  | **required** unless using the `from: mcp` bulk form.                                                   |
| `enabled`            | `boolean \| string`           | `true`                             | A string is treated as a condition, e.g. `"${env.FEATURE_ORDERS}"`.                                    |
| `timeoutMs`          | `integer`                     | `10000`                            |                                                                                                        |
| `maxCallsPerSession` | `integer`                     | unlimited                          | Abuse control per tool.                                                                                |

---

## 9. `knowledge`

Full pipeline spec in [`06-knowledge.md`](./06-knowledge.md).

```yaml
knowledge:
  sources:
    - type: sitemap
      url: https://acme.com/sitemap.xml
      include: ['/docs/**', '/blog/**']
      exclude: ['/docs/internal/**']
      maxPages: 500
    - type: crawl
      url: https://acme.com
      maxDepth: 3
      respectRobots: true
    - type: files
      glob: ./content/**/*.{md,mdx}
    - type: openapi
      url: ./openapi.yaml
    - type: text
      id: policies
      content: |
        Returns accepted within 30 days...

  extract:
    selector: main, article # CSS selector for the content region
    strip: [nav, footer, aside, .cookie-banner]
    format: markdown # markdown | text

  chunk:
    strategy: semantic # semantic | heading | fixed
    maxTokens: 512
    overlapTokens: 64

  embedding:
    provider: openai
    model: text-embedding-3-small
    apiKey: ${env.OPENAI_API_KEY}
    batchSize: 96

  store:
    type: sqlite # memory | sqlite | pgvector | upstash | custom
    path: ./.sitebot/index.db

  retrieval:
    mode: tool # tool | always | hybrid
    topK: 6
    minScore: 0.35
    maxContextTokens: 3000
    includeCitations: true
    rerank: false
```

Defaults: `chunk.strategy: semantic`, `chunk.maxTokens: 512`, `store.type: memory`, `retrieval.mode` follows `mode` (`always` for chat, `tool` for agent), `topK: 6`, `minScore: 0.3`.

If `knowledge.sources` is empty the whole subsystem is inert — no store is opened, no `search_knowledge_base` tool is registered.

---

## 10. `storage` — sessions

```yaml
storage:
  type: sqlite # none | memory | sqlite | redis | postgres | custom
  path: ./.sitebot/sessions.db
  ttlSeconds: 2592000 # 30 days
  maxMessagesPerSession: 100
  persistTranscripts: true
```

| `type`     | Behaviour                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`     | Fully stateless. Client sends complete history. **Approval gates and client-tool resume are unavailable** — validation error if `mode: agent`. |
| `memory`   | In-process Map. Dev only; loses state on restart and breaks across replicas.                                                                   |
| `sqlite`   | Default for single-node self-hosting.                                                                                                          |
| `redis`    | `url: ${env.REDIS_URL}`. Recommended for multi-replica.                                                                                        |
| `postgres` | `url: ${env.DATABASE_URL}`.                                                                                                                    |
| `custom`   | `module: "./storage/mine.ts"` implementing `SessionStore`.                                                                                     |

`persistTranscripts: false` keeps only the loop state needed for resume and drops message bodies at session end — the privacy-preserving option.

---

## 11. `ui` — fully public

Everything here is sent to the browser via `GET /api/chat/config`. Never put a secret in this block; the schema rejects `${env.*}` values under `ui` outright.

```yaml
ui:
  position: bottom-right # bottom-right | bottom-left
  offset: { x: 24, y: 24 }
  zIndex: 2147483000
  isolation: shadow # shadow | iframe

  launcher:
    label: Ask Acme # omit for icon-only
    icon: sparkle # sparkle | chat | question | custom
    iconUrl: /logo-mark.svg
    showAfterMs: 1200
    hideOnPaths: ['/checkout/**']
    badge: { enabled: true, text: New }

  panel:
    width: 400
    height: 640
    title: Acme # defaults to top-level `name`
    avatarUrl: /logo-mark.svg
    showAvatar: true
    showClose: true
    openOnFirstVisit: false
    rememberOpenState: true

  theme:
    mode: auto # auto | light | dark
    primary: '#4f46e5'
    onPrimary: '#ffffff'
    surface: '#ffffff'
    text: '#18181b'
    muted: '#71717a'
    bubbleAssistant: '#f1f1f1'
    bubbleUser: '#4f46e5'
    radius: 16
    font: inherit # inherit | system | a CSS font-family string
    shadow: '0 12px 48px rgba(0,0,0,0.16)'

  messages:
    greeting: Hi there! Looking to book a meeting or learn more about Acme?
    placeholder: 'Enter...'
    suggestions:
      - {
          label: 'Schedule a Meeting with Sales 📅',
          action: { type: send, text: I'd like to book a demo },
        }
      - {
          label: 'Start the Application 🚀',
          action: { type: navigate, path: /apply },
        }
      - {
          label: 'Chat with Sales now 💬',
          action: { type: tool, tool: handoff_to_human },
        }
    suggestionsPersist: false
    errorMessage: Something went wrong. Please try again.
    emptyStateAfterMs: 0

  footer:
    text: Acme provides this chat. You agree this chat may be recorded.
    linkText: Privacy Statement
    linkUrl: https://acme.com/privacy

  behaviour:
    streaming: true
    showTypingIndicator: true
    markdown: true
    allowFileUpload: false
    persistHistory: true # localStorage
    resetOnNavigate: false
    sound: false

  a11y:
    launcherAriaLabel: Open chat assistant
    panelAriaLabel: Chat with Acme assistant

  locale: auto # auto | a BCP-47 tag
  strings: # override any UI string per locale
    fr:
      greeting: Bonjour ! Comment puis-je vous aider ?
      placeholder: 'Écrivez...'
```

The `messages.greeting`, `suggestions`, and `footer` blocks map directly onto the reference screenshot. Rendering rules are in [`07-widget.md`](./07-widget.md).

---

## 12. `security`

```yaml
security:
  publicKey: pk_live_a1b2c3 # identifies this deployment to the widget
  allowedOrigins:
    - https://acme.com
    - https://*.acme.com
  rateLimit:
    perSession: 30/5m
    perIp: 100/1h
    store: memory # memory | redis
  budget:
    maxTokensPerSession: 50000
    maxTokensPerDay: 5000000
    maxUsdPerDay: 25
    onExceeded: message # message | error | degrade
    degradeTo: { provider: anthropic, model: claude-haiku-4-5-20251001 }
  auth:
    mode: optional # none | optional | required
    jwt:
      secret: ${env.SITEBOT_JWT_SECRET}
      algorithm: HS256
      issuer: acme.com
      audience: sitebot
      claimsMap: { userId: sub, email: email, tier: 'custom.tier' }
  redactPii: true
  piiPatterns: [email, phone, creditcard, iban]
  blockedPatterns:
    - '(?i)ignore (all )?previous instructions'
  maxRequestBytes: 262144
```

Defaults are deliberately safe: `auth.mode: optional`, `rateLimit.perSession: 30/5m`, `rateLimit.perIp: 100/1h`, `redactPii: false`, `maxRequestBytes: 262144`, and **`allowedOrigins` defaults to empty which means same-origin only**. A cross-origin sidecar deployment must opt in explicitly.

Rate limit syntax: `<count>/<window>` where window is `<n>[s|m|h|d]`.

---

## 13. `telemetry`

```yaml
telemetry:
  enabled: true
  otel: { enabled: true, serviceName: sitebot }
  events:
    webhook: ${env.EVENTS_WEBHOOK}
    include: [message, tool_call, error, finish]
  logLevel: info # silent | error | warn | info | debug
  redactPromptsInLogs: true
```

---

## 14. Validation and developer experience

- **JSON Schema is published** at `schema/chatbot.schema.json` and generated from Zod in the build. Users add one line for full autocomplete and inline validation in VS Code:
  ```yaml
  # yaml-language-server: $schema=./node_modules/@sitebot/config/schema/chatbot.schema.json
  ```
  `sitebot init` writes this line automatically.
- **Errors are actionable.** Every validation failure reports the YAML path, the offending value, the expectation, and a fix. Unknown keys are errors, not warnings, with a "did you mean" suggestion via Levenshtein distance.
- `sitebot validate` prints the fully resolved config with every secret replaced by `***` and every default made explicit, so the developer sees exactly what the engine will run.
- **Cross-field validation rules** (each with a dedicated error message):
  1. `mode: chat` forbids non-`readOnly` tools.
  2. `mode: agent` forbids `storage.type: none`.
  3. `provider: openai-compatible` requires `baseUrl`.
  4. `provider: custom` requires `module`.
  5. `knowledge.sources` non-empty requires `knowledge.embedding`.
  6. `store.type: sqlite` is rejected when the build target is edge.
  7. `security.auth.mode: required` requires `security.auth.jwt`.
  8. Any tool with `scope: authenticated` requires `security.auth.mode` ≠ `none`.
  9. Suggestion actions of `type: tool` must name a configured tool.
  10. `ui` may not contain `${env.*}`.
