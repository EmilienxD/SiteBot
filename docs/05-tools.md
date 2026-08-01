# 05 — Tools

Five executor kinds. Four of them require zero code.

| Kind      | Runs where  | Code required           | Covers                                                             |
| --------- | ----------- | ----------------------- | ------------------------------------------------------------------ |
| `http`    | Server      | none                    | Calling the developer's own REST API — the single most common need |
| `mcp`     | Server      | none                    | Any MCP server; imports an entire toolset at once                  |
| `builtin` | Server      | none                    | Knowledge search, human handoff, page navigation                   |
| `client`  | **Browser** | none (or a JS callback) | DOM interaction — what makes this a _website_ assistant            |
| `module`  | Server      | a TS file               | Anything else                                                      |

---

## 1. Registry and resolution

At boot, `ToolRegistry.build()` produces a `Record<string, Tool>` in AI SDK format.

```
config.tools[]
   │
   ├─ expand `from: mcp` entries → connect, list tools, filter by allow/deny, apply prefix
   ├─ resolve `module` paths → dynamic import, verify export is a function
   ├─ bind `builtin` ids → internal implementations
   ├─ compile `http` templates → validate URL/header placeholders against the parameter schema
   └─ register `client` tools → server-side stub that suspends the loop
   │
   ├─ apply mode filter (chat → readOnly only)
   ├─ apply `enabled` conditions
   ├─ apply identity filter (scope: authenticated + ctx.identity === null → excluded, with a note in <tool_policy>)
   └─ wrap every executor with: timeout, per-session call cap, telemetry span, error normalisation
   │
   ▼
Record<string, Tool>  →  streamText({ tools })
```

**Registry is built per request, cached per `(configHash, identityPresent, mode)`.** MCP connections are pooled at process level, not per request.

### Naming rules

- `^[a-z][a-z0-9_]{0,63}$`. Enforced at validation with a clear error.
- Duplicate names are a fatal config error, except when a TS `defineConfig` tool intentionally overrides a YAML one by name (§ [`02`](./02-configuration.md) merge rules).
- MCP `prefix` exists to avoid collisions when importing multiple servers.

### The wrapper

Every executor, regardless of kind, is wrapped identically:

```ts
async function wrapped(input: unknown, opts: ToolCallOptions) {
  const ctx = opts.experimental_context as RequestContext
  return withSpan(`tool.${name}`, async () => {
    if (def.scope === 'authenticated' && !ctx.identity)
      return {
        error: 'authentication_required',
        message: 'Ask the user to sign in first.',
      }
    if ((await ctx.budget.toolCalls(name)) >= def.maxCallsPerSession)
      return { error: 'call_limit_reached' }

    const parsed = validate(def.parameters, input) // never trust model output
    if (!parsed.ok) return { error: 'invalid_input', issues: parsed.issues }

    try {
      return await withTimeout(def.timeoutMs, () => executor(parsed.value, ctx))
    } catch (e) {
      ctx.logger.error('tool failed', { name, error: e })
      return {
        error: 'tool_failed',
        message: def.errorMessage ?? 'The tool could not complete.',
      }
    }
  })
}
```

Two invariants worth stating explicitly:

1. **Tool failures return structured errors to the model, they do not throw.** The model then explains the problem to the user, which is far better UX than a dead stream.
2. **Model-produced arguments are re-validated server-side** against the declared schema. Providers usually honour the schema; "usually" is not a security posture.

---

## 2. `http` executor

The workhorse. Turns any REST endpoint into a tool declaratively.

```yaml
- name: check_order_status
  description: |
    Look up the current status, carrier, and estimated delivery date of an
    order. Use when the user asks about a specific order by ID.
  readOnly: true
  scope: authenticated
  parameters:
    type: object
    properties:
      orderId:
        type: string
        pattern: '^ORD-[0-9]{4}$'
        description: The order ID, e.g. ORD-4821
    required: [orderId]
  executor:
    type: http
    method: GET
    url: https://api.acme.com/v1/orders/{orderId}
    headers:
      Authorization: Bearer ${env.ACME_API_KEY}
      X-Acting-User: '{{identity.sub}}'
    query:
      include: shipment
    timeoutMs: 8000
    responsePath: $.data
    maxResponseBytes: 32768
    errorMap:
      404: 'No order with that ID exists.'
      403: 'That order belongs to a different account.'
```

### Templating

Two distinct syntaxes, deliberately different so they cannot be confused:

| Syntax                                          | Source                                | Where allowed                      |
| ----------------------------------------------- | ------------------------------------- | ---------------------------------- |
| `{param}`                                       | **Tool arguments** (model-controlled) | `url` path, `query` values, `body` |
| `{{identity.*}}`, `{{session.*}}`, `{{page.*}}` | **Server-verified context**           | `url`, `headers`, `query`, `body`  |
| `${env.*}`                                      | Environment                           | resolved at config load            |

**Security rules, normative:**

1. Every `{param}` interpolated into a URL path or query is **percent-encoded**. No exceptions.
2. `{param}` may **not** appear in the host or scheme portion of `url`. Validation rejects `https://{host}/…`.
3. `{param}` may **not** appear in a header name or value. Model-controlled header injection is forbidden outright.
4. The resolved URL's host must match `executor.allowHosts` (defaults to the host literally written in `url`). This blocks SSRF via a crafted parameter.
5. Requests to private/loopback/link-local address ranges are refused unless `allowPrivateNetwork: true` is set explicitly.
6. Responses are capped at `maxResponseBytes` (default 64 KB) and truncated with a marker. A 5 MB JSON blob would blow the context window and the budget.

### Body mapping

```yaml
executor:
  type: http
  method: POST
  url: https://api.acme.com/v1/tickets
  body:
    subject: '{subject}'
    body: '{description}'
    requester: '{{identity.email}}'
    source: website_assistant
```

Default when `body` is omitted on a `POST`/`PUT`/`PATCH`: the entire validated argument object as JSON.

### Response shaping

- `responsePath` — JSONPath applied to the response before it reaches the model. Use it to strip envelopes and irrelevant fields; smaller tool results mean cheaper, more accurate turns.
- `errorMap` — maps status codes to model-readable messages. Unmapped non-2xx becomes `{ error: 'http_error', status }`.
- Non-JSON responses are returned as text (truncated); binary content types are refused.

---

## 3. `mcp` executor

MCP gives us an entire tool ecosystem for free, and — more interestingly — gives the developer a clean way to expose their own backend: they write one MCP server, and it works with our widget _and_ Claude Desktop _and_ their IDE.

### Bulk import form

```yaml
tools:
  - from: mcp
    id: acme # used in health checks and telemetry
    server:
      transport: http # http | stdio | sse
      url: https://acme.com/mcp
      headers:
        Authorization: Bearer ${env.MCP_TOKEN}
    allow: [search_docs, list_plans, get_changelog]
    deny: []
    prefix: acme_
    readOnly: true # applied to all imported tools
    requiresApproval: false
    timeoutMs: 15000
```

```yaml
    server:
      transport: stdio             # Node/self-hosted only, never on edge
      command: node
      args: ["./mcp/server.js"]
      env: { API_KEY: ${env.ACME_API_KEY} }
```

### Rules

1. **`allow` is mandatory in production.** Omitting it imports every tool the server exposes, which means a server update can silently grant the assistant new capabilities. Validation emits a warning when `allow` is absent and an error when `security.strictTools: true`.
2. Tool descriptions and schemas come from the server. They are **untrusted text that reaches the model** — a malicious or compromised MCP server can attempt instruction injection through a tool description. Descriptions are therefore length-capped (1024 chars) and included in the untrusted-content framing.
3. Connections are pooled per `id` at process level with lazy connect, health checks, and reconnect-with-backoff. A dead MCP server degrades `/health` and removes its tools from the registry rather than failing every request.
4. `stdio` transport is unavailable on edge targets; validation rejects the combination.
5. MCP tool results pass through the same size cap as `http`.

### Single-tool form

```yaml
- name: search_docs
  description: Search Acme documentation. # override the server's description
  executor:
    type: mcp
    server: { transport: http, url: https://acme.com/mcp }
    tool: search_docs
```

---

## 4. `builtin` executor

Implementations we ship. Registered by `id`.

| `id`                    | Purpose                                                                            | Available when                 |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------ |
| `search_knowledge_base` | Query the vector index. Returns chunks + emits `data-citations`.                   | `knowledge.sources` non-empty  |
| `list_site_sections`    | Returns `siteContext.routes`. Cheap orientation for the model.                     | always                         |
| `get_page_context`      | Returns the current page context on demand (for when `includePageContext: false`). | always                         |
| `handoff`               | Escalate to a human.                                                               | configured                     |
| `navigate`              | Send the host page to a declared route. Client-side effect via `data-navigate`.    | `siteContext.routes` non-empty |
| `collect_lead`          | Structured capture of name/email/company into the events webhook.                  | configured                     |
| `submit_feedback`       | Record a user complaint/suggestion.                                                | always                         |
| `get_time`              | Current date/time in a timezone. Prevents the model guessing "today".              | always                         |

### `search_knowledge_base`

```yaml
- name: search_knowledge_base
  description: Search Acme's documentation and site content. # optional override
  executor:
    type: builtin
    id: search_knowledge_base
    topK: 6
    minScore: 0.35
    filter: { source: docs }
```

Auto-registered in agent mode when knowledge is configured, so it usually needs no config entry at all.

### `handoff`

```yaml
- name: handoff_to_human
  description: Connect the user to a human from the sales or support team.
  executor:
    type: builtin
    id: handoff
    target:
      kind: webhook # webhook | intercom | crisp | zendesk | email | url
      url: ${env.SLACK_WEBHOOK}
      includeTranscript: true
    message: A human will reply here shortly.
```

Emits a `data-handoff` part. For `kind: intercom` / `crisp`, the widget calls the vendor's global (`window.Intercom('showNewMessage', …)`) if present, else falls back to the configured URL.

---

## 5. `client` executor — the differentiator

A client tool's arguments are produced by the model on the server, but the _execution_ happens in the browser with full DOM access. This is what lets the assistant do things a generic chatbot cannot: scroll the user to the relevant paragraph, open the pricing modal, prefill a form, read the cart.

### Flow

```
server: model calls highlight_section({selector: "#pricing-enterprise"})
server: registry sees type:client → checkpoint run, emit data-client-tool-call, close stream
widget: verify "highlight_section" ∈ config.capabilities.clientTools     ← authoritative allowlist
widget: run the handler (builtin or developer-registered)
widget: POST /api/chat { trigger:"resume", resume:{ runId, clientToolResults:[…] } }
server: rehydrate, inject the result, continue the loop
```

### Built-in client tools

| `id`                | Effect                                                                             |
| ------------------- | ---------------------------------------------------------------------------------- |
| `highlight`         | `scrollIntoView({behavior:'smooth'})` + a temporary outline on the matched element |
| `navigate`          | `location.assign(path)` or `history.pushState` for SPA routes                      |
| `fill_form`         | Set values on named inputs within a form. **Never submits.**                       |
| `read_element`      | Return the text content of a selector (e.g. read the cart total)                   |
| `get_page_context`  | Return a fresh extraction                                                          |
| `open_url`          | `window.open` in a new tab                                                         |
| `copy_to_clipboard` | Copy text, show a toast                                                            |

### Developer-registered

```js
window.SiteBot.registerTool('get_cart', () => ({
  items: store.cart.items.map((i) => ({ sku: i.sku, qty: i.qty })),
  total: store.cart.total,
}))
```

```yaml
- name: get_cart
  description: Read the contents of the user's shopping cart.
  readOnly: true
  parameters: { type: object, properties: {} }
  executor: { type: client, id: get_cart }
```

### Client-tool safety rules — normative

1. **Server-declared allowlist wins.** The widget executes only names present in `capabilities.clientTools`. A `data-client-tool-call` for anything else is dropped and reported as an `error` event.
2. `navigate` may only target paths declared in `siteContext.routes`, or matching `ui.behaviour.navigateAllowlist`. Open redirect is not acceptable.
3. `fill_form` writes values but never dispatches submit. A model must not be able to place an order by filling a form.
4. `read_element` is subject to a `readSelectorDenylist` (default: `input[type=password]`, `[data-sensitive]`, `iframe`) so it cannot exfiltrate credentials.
5. Client tool results are capped at 16 KB and validated against the tool's declared _output_ schema when one is supplied.
6. Every client tool call is surfaced in the panel as a visible tool chip. Silent DOM manipulation driven by a model is not acceptable UX.
7. Client tools that are not `readOnly` are subject to the same approval gate as server tools.

---

## 6. `module` executor

```yaml
- name: calculate_quote
  description: Compute a shipping quote for a route and weight.
  parameters:
    type: object
    properties:
      origin: { type: string }
      destination: { type: string }
      weightKg: { type: number }
    required: [origin, destination, weightKg]
  executor:
    type: module
    path: ./tools/quote.ts
    export: calculateQuote # default: `default`
```

```ts
// tools/quote.ts
import type { ToolContext } from '@sitebot/core'

export async function calculateQuote(
  input: { origin: string; destination: string; weightKg: number },
  ctx: ToolContext,
) {
  ctx.logger.debug('quoting', input)
  const rate = await rates.lookup(input.origin, input.destination)
  return { currency: 'EUR', amount: rate * input.weightKg, etaDays: rate.eta }
}
```

The `defineConfig` inline form (§[`02`](./02-configuration.md) §1) is preferred when the developer is already writing TS — it gives Zod-typed parameters and full inference. `module` exists so the YAML file can stay the single source of truth while logic lives elsewhere.

Module paths are resolved relative to the config file and loaded once at boot. In `dev`, they are hot-reloaded on change.

---

## 7. Approval gates

The mechanism that makes agent mode deployable on a public site.

### Configuration

```yaml
agent:
  approvalRequired: [create_ticket, submit_order]
  approvalPolicy: always # always | once-per-session | never
```

or per tool:

```yaml
- name: submit_order
  requiresApproval: true
  approvalRisk: high # low | medium | high → drives card styling
  approvalSummary: 'Place order {orderId} for {{identity.email}}'
```

### Flow

The stream carries:

```jsonc
{
  "type": "data-approval-request",
  "data": {
    "approvalId": "a_01J9…",
    "runId": "r_01J9…",
    "toolName": "create_ticket",
    "title": "Create a support ticket",
    "description": "Subject: \"Missing shipment\" — will be filed under your account.",
    "input": { "subject": "Missing shipment", "priority": "high" },
    "risk": "medium",
  },
}
```

The widget renders a card showing the tool's human title, the summary, and — behind a "Show details" disclosure — the exact arguments. Approve / Deny buttons. Deny resumes the loop with `{ error: 'user_denied' }` so the model can respond gracefully.

### Rules

1. Approval state is bound to `(sessionId, runId, approvalId)`. Replay or cross-session use is a 403.
2. `once-per-session` caches a granted approval **per tool name and argument hash**, not per tool alone — approving "ticket about shipping" must not silently approve "delete account".
3. Approval cards are keyboard-accessible and focus-trapped; Enter does **not** default to Approve.
4. An expired checkpoint renders "This request timed out" with a Retry that starts a fresh turn.
5. `approvalPolicy: never` is honoured but `sitebot validate` warns when any non-`readOnly` tool is reachable without approval.

---

## 8. Writing good tool descriptions

The single highest-leverage thing a developer does in this config, and the thing they will get wrong. `sitebot validate` lints for it:

| Lint                         | Rule                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `tool/description-too-short` | < 20 chars → warning                                                                             |
| `tool/no-usage-guidance`     | Description lacks a "Use when…" clause → info                                                    |
| `tool/param-undocumented`    | A parameter property has no `description` → warning                                              |
| `tool/name-not-verb`         | Name does not start with a verb-like token → info                                                |
| `tool/overlapping-tools`     | Two descriptions are > 0.85 cosine-similar → warning (models pick badly between near-duplicates) |

`sitebot init` scaffolds a commented example demonstrating the good pattern:

```yaml
description: |
  Look up the current status, carrier, and estimated delivery date of an order.
  Use when the user asks about a specific order and provides an ID.
  Do not use for general shipping-policy questions — search the knowledge base instead.
```

---

## 9. Testing

| Executor  | Test approach                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http`    | MSW-intercepted fetch. Table-driven cases for encoding, SSRF attempts (`{orderId}` = `../../admin`, `@evil.com`), header injection, size caps, `errorMap`. |
| `mcp`     | In-process mock MCP server over both transports. Assert allow/deny filtering, prefixing, reconnect, degraded health.                                       |
| `builtin` | Unit tests against a seeded in-memory vector store and a stub handoff webhook.                                                                             |
| `client`  | Playwright. Assert allowlist rejection, navigate restriction, `fill_form` does not submit, password fields unreadable.                                     |
| `module`  | Fixture modules; assert path resolution, bad-export error message, hot reload in dev.                                                                      |
| Approvals | Integration: approve, deny, replay across sessions, expiry, `once-per-session` argument-hash behaviour.                                                    |
| Wrapper   | Property tests: every executor kind returns a structured error rather than throwing, for every injected failure mode.                                      |
