# 03 — Protocol

How the widget and the server talk. Four endpoints, one streaming format, one JS API.

---

## 1. Endpoints

All mounted under a configurable base path (default `/api/chat`).

| Method | Path                 | Purpose                                  |
| ------ | -------------------- | ---------------------------------------- |
| `POST` | `/api/chat`          | The conversation. Returns an SSE stream. |
| `GET`  | `/api/chat/config`   | Public UI config. Cacheable.             |
| `POST` | `/api/chat/feedback` | Thumbs up/down, free-text report.        |
| `GET`  | `/api/chat/health`   | Readiness + config validity.             |

`OPTIONS` on all four for CORS preflight.

---

## 2. `POST /api/chat`

### Request

```
Content-Type: application/json
X-SiteBot-Key: pk_live_a1b2c3
Origin: https://acme.com
```

```jsonc
{
  "sessionId": "s_01J9X8Y7Z6", // client-generated ULID, stable per browser session
  "messages": [
    // UIMessage[] — see §3
    {
      "id": "m_01J9X8Y7Z7",
      "role": "user",
      "parts": [{ "type": "text", "text": "Where is my order ORD-4821?" }],
    },
  ],
  "pageContext": {
    "url": "https://acme.com/orders",
    "path": "/orders",
    "title": "Your Orders — Acme",
    "description": "Track and manage your shipments.",
    "locale": "en-US",
    "referrer": "https://acme.com/",
    "selection": null, // user-highlighted text, if any
    "extract": "Order ORD-4821 …", // distilled page text, ≤ 4000 chars
    "meta": { "og:type": "website" },
    "custom": { "plan": "pro" }, // set by SiteBot.setContext()
  },
  "auth": "eyJhbGciOi…", // optional signed JWT from the host site
  "resume": {
    // present only when continuing a suspended loop
    "runId": "r_01J9X8Y7Z8",
    "approvals": [{ "approvalId": "a_1", "decision": "approve" }],
    "clientToolResults": [
      { "toolCallId": "tc_1", "output": { "scrolled": true } },
    ],
  },
  "trigger": "submit-message", // submit-message | regenerate | resume
}
```

| Field         | Required | Notes                                                                                                                                                                                             |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`   | yes      | Server validates format, binds to IP+origin on first sight.                                                                                                                                       |
| `messages`    | yes      | With server-side storage, only the **last user message** is trusted; prior history is loaded from the store. With `storage.type: none`, the full array is used (see [`08`](./08-security.md) §6). |
| `pageContext` | no       | Omitted if `prompt.includePageContext: false`.                                                                                                                                                    |
| `auth`        | no       | Required when `security.auth.mode: required`.                                                                                                                                                     |
| `resume`      | no       | Mutually exclusive with a new user message.                                                                                                                                                       |

### Response

```
200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Vercel-AI-UI-Message-Stream: v1
X-SiteBot-Run-Id: r_01J9X8Y7Z8
```

Body: **AI SDK UI Message Stream** over SSE. Each event is `data: <json>\n\n`, terminated by `data: [DONE]`.

Error status codes are returned _before_ the stream opens when possible:

| Status | `code`              | Meaning                                    |
| ------ | ------------------- | ------------------------------------------ |
| 400    | `invalid_request`   | Malformed body, message too long           |
| 401    | `auth_required`     | `auth.mode: required` and no/invalid JWT   |
| 403    | `origin_denied`     | Origin not in `allowedOrigins`             |
| 403    | `invalid_key`       | Bad `X-SiteBot-Key`                        |
| 413    | `payload_too_large` | Exceeds `maxRequestBytes`                  |
| 429    | `rate_limited`      | Includes `Retry-After`                     |
| 402    | `budget_exceeded`   | When `budget.onExceeded: error`            |
| 502    | `provider_error`    | All providers in the fallback chain failed |
| 503    | `not_ready`         | Config invalid or store unreachable        |

Once the stream is open, failures arrive as an `error` stream part instead.

---

## 3. Message model

We use the AI SDK v6 split: **`UIMessage`** on the wire and in the widget, **`ModelMessage`** internally when calling the provider. The widget never sees `ModelMessage`.

```ts
interface UIMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: UIMessagePart[]
  metadata?: {
    createdAt: number
    model?: string
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
    finishReason?: string
  }
}
```

### Standard part types (from the AI SDK)

| Part                             | Rendered as                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `text`                           | Markdown bubble                                                                                   |
| `reasoning`                      | Collapsed "Thinking" disclosure, hidden unless `ui.behaviour.showReasoning`                       |
| `tool-<name>`                    | Tool chip with state `input-streaming` → `input-available` → `output-available` \| `output-error` |
| `source-url` / `source-document` | Feeds the citation footnote list                                                                  |
| `file`                           | Attachment card                                                                                   |
| `step-start`                     | Step separator (agent mode, debug view only)                                                      |
| `data-<name>`                    | **Our custom parts — see §4**                                                                     |

---

## 4. Custom data parts

This is where widget-specific behaviour lives. Each is a typed, transient or persistent data part streamed by the engine.

| Part type               | Payload                                                                                          | Widget behaviour                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `data-citations`        | `{ items: [{ id, title, url, snippet, score }] }`                                                | Renders numbered source chips under the message                          |
| `data-approval-request` | `{ approvalId, toolName, toolCallId, title, description, input, risk: 'low'\|'medium'\|'high' }` | Renders a confirm card with Approve / Deny. Stream ends after this part. |
| `data-client-tool-call` | `{ toolCallId, toolName, input }`                                                                | Widget executes the registered client tool, POSTs the result back        |
| `data-suggestions`      | `{ items: [{ label, action }] }`                                                                 | Replaces the quick-reply pill row                                        |
| `data-navigate`         | `{ path, newTab }`                                                                               | Navigates the host page (only to `siteContext.routes` paths)             |
| `data-handoff`          | `{ target, ticketUrl?, message }`                                                                | Renders a handoff card, optionally opens the vendor widget               |
| `data-status`           | `{ text }`                                                                                       | Transient status line, e.g. "Searching documentation…"                   |
| `data-error`            | `{ code, message, retryable }`                                                                   | Inline error bubble with a Retry affordance                              |
| `data-usage`            | `{ inputTokens, outputTokens, costUsd }`                                                         | Debug overlay only                                                       |

`data-status` and `data-client-tool-call` are **transient** (`transient: true`), so they are not persisted into message history.

### Example stream

```
data: {"type":"start","messageId":"m_9"}

data: {"type":"data-status","transient":true,"data":{"text":"Searching documentation…"}}

data: {"type":"tool-input-start","toolCallId":"tc_1","toolName":"search_knowledge_base"}

data: {"type":"tool-input-available","toolCallId":"tc_1","input":{"query":"order tracking"}}

data: {"type":"tool-output-available","toolCallId":"tc_1","output":{"hits":3}}

data: {"type":"data-citations","data":{"items":[{"id":"c1","title":"Tracking orders","url":"https://acme.com/docs/tracking","snippet":"…","score":0.82}]}}

data: {"type":"text-start","id":"t1"}

data: {"type":"text-delta","id":"t1","delta":"Your order "}

data: {"type":"text-delta","id":"t1","delta":"ORD-4821 shipped yesterday."}

data: {"type":"text-end","id":"t1"}

data: {"type":"finish","messageMetadata":{"usage":{"inputTokens":1840,"outputTokens":42,"totalTokens":1882}}}

data: [DONE]
```

---

## 5. Suspend / resume

Two things suspend the loop: an **approval gate** and a **client tool call**. Both use the same mechanism.

```
Server                                   Widget
──────                                   ──────
… loop running …
model calls create_ticket
  (in approvalRequired)

checkpoint loop state → session store
emit data-approval-request      ────────▶  render confirm card
close stream (finish, reason:
  "suspended")                             user clicks Approve

                                ◀────────  POST /api/chat
                                           { sessionId, trigger:"resume",
                                             resume:{ runId, approvals:[…] } }
rehydrate run r_… from store
verify approvalId + session binding
execute the tool
continue loop from step N       ────────▶  stream resumes
```

Rules:

1. A checkpoint is bound to `(sessionId, runId)`. Presenting a `runId` from another session is a 403.
2. Checkpoints expire after `agent.stopWhen.seconds × 10` or 15 minutes, whichever is greater. Expired resume → `410 run_expired`, widget renders "This request timed out".
3. A `deny` decision resumes the loop straight away, and the model receives the call's tool result as `execution-denied` with reason `user_denied`. That lets it respond gracefully rather than dying. A denied client tool never reaches the page.
4. **An approved client tool takes two round trips.** The server has no executor for it, so the approval resume does not call the model. It moves the tool part to `input-available`, keeps the checkpoint, and answers with only `data-client-tool-call` for the released calls. The widget runs them, then resumes again with `clientToolResults`, and that resume continues the loop. A denied client tool resumes the model directly, as in rule 3.
5. Because state lives in the session store, **the user can reload the page and still resume** — the widget rehydrates pending approvals from `GET /api/chat/config`'s session probe. This is why `storage.type: none` forbids agent mode.

---

## 6. `GET /api/chat/config`

```
GET /api/chat/config?key=pk_live_a1b2c3&sessionId=s_01J9X8Y7Z6
→ 200, Cache-Control: public, max-age=60, stale-while-revalidate=600
```

```jsonc
{
  "name": "Acme Assistant",
  "mode": "agent",
  "ui": {/* the entire resolved `ui` block */},
  "capabilities": {
    "streaming": true,
    "fileUpload": false,
    "clientTools": ["highlight_section", "navigate", "get_page_context"],
    "authMode": "optional",
  },
  "pending": {
    // present only when sessionId is supplied
    "runId": "r_01J9X8Y7Z8",
    "approval": { "approvalId": "a_1", "toolName": "create_ticket", "…": "…" },
  },
  "version": "1.0.0",
}
```

The `clientTools` array tells the widget which tool names it is allowed to execute locally. **The widget refuses any `data-client-tool-call` for a name not in this list** — the server-declared allowlist, not the stream, is authoritative.

Caching: keyed on `key`. When `sessionId` is present the response is `Cache-Control: private, no-store` because it carries `pending`.

---

## 7. `POST /api/chat/feedback`

```jsonc
{
  "sessionId": "s_…",
  "messageId": "m_9",
  "rating": "up", // up | down
  "reason": "inaccurate", // optional enum
  "comment": "Wrong ETA", // optional, ≤ 1000 chars
}
```

→ `204 No Content`. Dispatched to `telemetry.events.webhook` and the `onFeedback` hook.

---

## 8. `GET /api/chat/health`

```jsonc
{
  "status": "ok", // ok | degraded | error
  "version": "1.0.0",
  "config": { "valid": true, "mode": "agent", "toolCount": 7 },
  "checks": {
    "provider": { "status": "ok", "latencyMs": 210 },
    "knowledge": {
      "status": "ok",
      "documents": 412,
      "lastIndexed": "2026-07-30T09:11:00Z",
    },
    "storage": { "status": "ok" },
    "mcp:acme": { "status": "degraded", "error": "timeout" },
  },
}
```

`degraded` (200) when a non-essential subsystem is down; `error` (503) when the provider or storage is unusable. Provider checks are cached for 30 s to avoid hammering.

---

## 9. Browser JS API

The script tag exposes a global. Every method is safe to call before the widget finishes booting — calls are queued.

```ts
interface SiteBotApi {
  // lifecycle
  open(): void
  close(): void
  toggle(): void
  destroy(): void
  isOpen(): boolean

  // conversation
  send(text: string, opts?: { hidden?: boolean }): void // hidden: don't render the user bubble
  reset(): void
  setSuggestions(items: Suggestion[]): void

  // context & identity
  identify(jwt: string): void // signed by the host site
  clearIdentity(): void
  setContext(data: Record<string, unknown>): void // merged into pageContext.custom
  refreshPageContext(): void // call after SPA route changes

  // client tools
  registerTool(
    name: string,
    fn: (input: unknown) => unknown | Promise<unknown>,
  ): void
  unregisterTool(name: string): void

  // events
  on(event: SiteBotEvent, handler: (payload: any) => void): () => void

  // introspection
  ready: Promise<void>
  version: string
}
```

### Events

| Event            | Payload                                                       |
| ---------------- | ------------------------------------------------------------- |
| `ready`          | `{ config }`                                                  |
| `open` / `close` | `{}`                                                          |
| `message`        | `{ role, text, messageId }`                                   |
| `tool`           | `{ name, phase: 'call'\|'result'\|'error', input?, output? }` |
| `approval`       | `{ approvalId, toolName, decision? }`                         |
| `citation-click` | `{ url, title }`                                              |
| `handoff`        | `{ target }`                                                  |
| `error`          | `{ code, message }`                                           |
| `feedback`       | `{ messageId, rating }`                                       |

### SPA integration

```js
// after a client-side route change
router.afterEach(() => window.SiteBot.refreshPageContext())
```

`refreshPageContext()` re-reads URL/title/meta and re-extracts page text. Without it, an SPA would keep sending the first page's context. `sitebot init` writes this snippet into the scaffolded example for React/Vue/Svelte routers.

---

## 10. Page context extraction

Performed by the widget, on open and on `refreshPageContext()`. Deterministic algorithm:

1. Collect `location.href`, `document.title`, `<meta name="description">`, `<meta property="og:*">`, `document.documentElement.lang`, `document.referrer`.
2. Select the content root: first match of `ui.extract.selector` (default `main, article, [role="main"]`), else `document.body`.
3. Clone it, remove `script`, `style`, `noscript`, `nav`, `footer`, `aside`, `svg`, `[aria-hidden="true"]`, and any `ui.extract.strip` selectors, plus the widget's own host element.
4. Convert to text preserving heading hierarchy (`# `, `## `) and list markers; collapse whitespace. A heading with a simple `id` carries it as a selector, `## [#storage] Storing beans`, so a highlight tool targets the real element instead of guessing one from the heading text.
5. Outline up to 5 forms that have a usable selector (a simple `id`, or `name`), one line each: `[Form #wholesale-form: email (email), volume (select: 5-20 "5–20 kg" | 50+ "Over 50 kg")]`. Field names, types and select/radio options only — never current values, and never hidden, password or file inputs. The outline is capped at 1200 characters and appended after the text, which gets the rest of the budget, so `fill_form` sees valid options instead of guessing.
6. Truncate the text to 4000 characters, less the outline's length, at a sentence boundary, appending `…[truncated]`.
7. Capture `window.getSelection().toString()` if non-empty and ≤ 1000 chars.

Cost control: the extract is hashed; if the hash is unchanged from the previous request in the same session, the widget sends `extractHash` instead of `extract` and the server reuses the stored copy.

---

## 11. Transport details

- **SSE, not WebSockets.** Works through every proxy and CDN, no connection state to manage, native `EventSource` semantics, and it is what the AI SDK emits. WebSockets buy nothing here — the interaction is strictly request/response-with-streaming.
- **POST + `fetch` streaming**, not `EventSource` — `EventSource` cannot POST a body.
- **Abort:** the widget's Stop button aborts the `fetch`; the server sees `signal` fire and cancels the model call and any in-flight tool calls.
- **Reconnect:** on a network drop mid-stream the widget silently retries once with `trigger: "regenerate"`, dropping the partial assistant message first. The server dedupes the user turn by message id, so the retry cannot double it. A second failure shows an error bubble with a manual Retry. `trigger: "resume"` is reserved for suspended runs (§5) and is never used for reconnection: it needs an approval or client-tool result, and a dropped stream has neither.
- **Compression:** `Content-Encoding` must not be applied to the SSE response by intermediaries; the server sets `X-Accel-Buffering: no` and `Cache-Control: no-transform` to defeat nginx/Cloudflare buffering.
