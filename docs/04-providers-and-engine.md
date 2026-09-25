# 04 — Providers and the Engine

---

## 1. Why the AI SDK

We do not write a provider abstraction. `ai` v6 already gives us a unified `LanguageModel` interface across every major provider, normalised tool calling, multi-step loops, a documented streaming wire format, and typed usage/finish metadata. Building our own would mean reimplementing all of that and then chasing every provider's API drift forever.

What we _do_ own: config → model resolution, the fallback chain, prompt composition, the tool registry, guards, and the suspend/resume machinery. Those are our product; the transport to the model is not.

**Version pin:** `ai@^6`, provider packages `@ai-sdk/*@^3` (whatever majors pair with `ai` v6 at implementation time — verify before the first commit). The v5→v6 change that matters to us is the `UIMessage` / `ModelMessage` split and native SSE, both of which this spec already assumes.

---

## 2. Provider registry

```ts
// packages/core/src/providers/registry.ts

type ProviderFactory = (cfg: BackendConfig) => Promise<LanguageModel>

const REGISTRY: Record<ProviderId, () => Promise<ProviderFactory>> = {
  anthropic: () => import('./adapters/anthropic'),
  openai: () => import('./adapters/openai'),
  google: () => import('./adapters/google'),
  // …
}

export async function resolveModel(cfg: BackendConfig): Promise<ResolvedModel> {
  const load = REGISTRY[cfg.provider]
  if (!load)
    throw new ConfigError(`Unknown provider "${cfg.provider}"`, {
      suggest: nearest(cfg.provider),
    })
  try {
    const factory = await load()
    return { model: await factory(cfg), id: `${cfg.provider}:${cfg.model}` }
  } catch (e) {
    if (isModuleNotFound(e)) {
      throw new ConfigError(
        `Provider "${cfg.provider}" requires an optional dependency.\n` +
          `  Install it:  pnpm add ${PACKAGE_FOR[cfg.provider]}`,
      )
    }
    throw e
  }
}
```

Three properties this must have:

1. **Lazy.** Only the configured provider's package is imported. A project using Anthropic never loads the OpenAI SDK.
2. **Optional peer deps.** Provider packages are `peerDependenciesMeta: { optional: true }`. A missing one produces the install command above, not a stack trace.
3. **Model IDs are pass-through.** We never maintain an allowlist of model names. A model released after this package was published works immediately.

### Adapter shape

Each adapter is ~15 lines. Example:

```ts
// providers/adapters/anthropic.ts
import { createAnthropic } from '@ai-sdk/anthropic'

export default async function (cfg: BackendConfig): Promise<LanguageModel> {
  const provider = createAnthropic({
    apiKey: cfg.apiKey ?? process.env.ANTHROPIC_API_KEY,
    baseURL: cfg.baseUrl,
    headers: cfg.headers,
  })
  return provider(cfg.model)
}
```

`provider: custom` loads `cfg.module` and expects the same signature, giving a full escape hatch without us anticipating every gateway.

---

## 3. Fallback chain

```yaml
backend:
  provider: anthropic
  model: claude-opus-5
  maxRetries: 2
  fallback:
    - { provider: anthropic, model: claude-sonnet-5 }
    - { provider: openai, model: gpt-5, apiKey: ${env.OPENAI_API_KEY} }
```

Semantics:

1. Try the primary, with `maxRetries` attempts using exponential backoff + jitter (250 ms base, ×2, ±20%).
2. Retry **within** a provider only for: `429`, `500`, `502`, `503`, `504`, connection reset, and timeout.
3. **Never retry** `400`, `401`, `403`, `404`, context-length-exceeded, or content-filter refusals — these will not succeed on retry.
4. On exhaustion, move to the next fallback entry. Each inherits the primary's `temperature`, `maxOutputTokens`, etc. unless it overrides them.
5. Fallback is **only attempted before the first token is emitted.** Once the stream has produced output, switching models mid-answer would produce incoherent text; instead we emit a `data-error` part with `retryable: true`.
6. Every fallback hop emits a `provider_fallback` telemetry event with the reason. Silent degradation is a bug.
7. If all entries fail: `502 provider_error` (pre-stream) or a terminal `error` part (mid-stream).

**Budget-driven degradation** is separate: when `security.budget.onExceeded: degrade`, the engine switches to `budget.degradeTo` _before_ the call, not as an error path.

---

## 4. The engine — one loop, two modes

```ts
// packages/core/src/agent/run.ts

export async function run(input: RunInput, ctx: RequestContext): Promise<UIMessageStream> {
  const policy = resolvePolicy(config)          // ← the ONLY place mode matters

  const tools = await registry.build({
    mode: config.mode,
    identity: ctx.identity,
    filter: policy.toolFilter,
  })

  const system = await composePrompt({ config, ctx, retrieval: policy.retrieval })

  return streamText({
    model: await selectModel(config, ctx),
    system,
    messages: toModelMessages(input.messages),
    tools,
    toolChoice: policy.toolChoice,
    stopWhen: policy.stopWhen,
    temperature: config.backend.temperature,
    maxOutputTokens: config.backend.maxOutputTokens,
    abortSignal: ctx.signal,
    experimental_telemetry: { isEnabled: config.telemetry.otel.enabled, functionId: 'sitebot.run' },
    onStepFinish: (step) => onStep(step, ctx),
    onFinish: (r) => onFinish(r, ctx),
  }).toUIMessageStreamResponse({ ... })
}
```

### Policy resolution

```ts
function resolvePolicy(c: ResolvedConfig): Policy {
  if (c.mode === 'chat')
    return {
      stopWhen: stepCountIs(1),
      toolFilter: (t) => t.readOnly === true,
      toolChoice: c.tools.length ? 'auto' : 'none',
      retrieval: c.knowledge.retrieval.mode ?? 'always',
      approvals: false,
    }
  return {
    stopWhen: [
      stepCountIs(c.agent.stopWhen.steps),
      tokenBudgetIs(c.agent.stopWhen.tokens),
      wallClockIs(c.agent.stopWhen.seconds),
    ],
    toolFilter: () => true,
    toolChoice: c.agent.toolChoice,
    retrieval: c.knowledge.retrieval.mode ?? 'tool',
    approvals: true,
  }
}
```

That function is the entire difference between "simple chatbot" and "AI agent". Nothing else in the codebase branches on `mode`.

### Stop conditions

Three conditions, OR'd. Custom `tokenBudgetIs` and `wallClockIs` are ours (the AI SDK ships `stepCountIs`):

```ts
const tokenBudgetIs =
  (max: number): StopCondition =>
  ({ steps }) =>
    steps.reduce((n, s) => n + s.usage.totalTokens, 0) >= max

const wallClockIs = (seconds: number): StopCondition => {
  const deadline = Date.now() + seconds * 1000
  return () => Date.now() >= deadline
}
```

### `onMaxSteps` behaviour

| Value                 | Effect when the loop hits its ceiling                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `summarize` (default) | One extra call with `toolChoice: 'none'` and an injected instruction to answer from what it has. Costs one call, always produces a usable reply. |
| `error`               | Terminal `data-error` part, `code: max_steps_exceeded`.                                                                                          |
| `silent`              | Stream ends with whatever text was produced.                                                                                                     |

---

## 5. Prompt composition

Deterministic, ordered, and testable. `composePrompt` is a pure function of `(config, ctx, retrievedDocs)` — snapshot-tested.

```
┌─ prompt.system, with {{variables}} substituted ────────────────┐
│ You are Acme's website assistant…                              │
└────────────────────────────────────────────────────────────────┘

┌─ <site_context> ───────────────────────────────────────────────┐
│ Company: Acme Inc                                              │
│ Description: B2B logistics SaaS…                               │
│ Known facts:                                                   │
│  - Support hours are 9-18 CET, Monday to Friday                │
│ Site sections:                                                 │
│  - /pricing — Plans, pricing tiers, and the ROI calculator     │
└────────────────────────────────────────────────────────────────┘

┌─ <page_context> ───────────────────────────────────────────────┐
│ (untrusted — reference only, see 08-security §4)               │
│ The user is currently viewing:                                 │
│ URL: https://acme.com/orders                                   │
│ Title: Your Orders — Acme                                      │
│ Page content:                                                  │
│ """                                                            │
│ …distilled text…                                               │
│ """                                                            │
└────────────────────────────────────────────────────────────────┘

┌─ <knowledge> ──────────────────────────────────────────────────┐  only if
│ (untrusted — reference only)                                   │  retrieval.mode
│ [1] Tracking orders — https://acme.com/docs/tracking           │  is always|hybrid
│ …                                                              │
└────────────────────────────────────────────────────────────────┘

┌─ <tool_policy> ────────────────────────────────────────────────┐  generated
│ - `create_ticket` requires user approval before it runs.       │
│ - `check_order_status` requires a signed-in user. The current  │
│   user is signed in as user_8842.                              │
│ - Cite sources with [n] when you use knowledge results.        │
└────────────────────────────────────────────────────────────────┘

┌─ <guardrails> ─────────────────────────────────────────────────┐  if enabled
│ Only answer questions about Acme…                              │
└────────────────────────────────────────────────────────────────┘
```

**Caching:** blocks 1, 2, 5 and 6 are stable across a session. On providers with explicit prompt caching, mark the boundary after block 2 (and after block 6 when page context is absent) as a cache breakpoint. Blocks 3 and 4 vary per request and must come _after_ everything stable — this ordering is not cosmetic, it is what makes caching effective.

---

## 6. History management

Before the model call:

1. Load stored history for `sessionId` (unless `storage.type: none`).
2. Append the new user message from the request. **Only the last user message from the request body is trusted** when server storage is on.
3. Truncate: keep the system prompt, the most recent `N` messages where the running token estimate stays under `contextBudget = maxContextTokens − systemTokens − maxOutputTokens − 20%` headroom.
4. Never split a tool-call/tool-result pair — truncate to a clean assistant-message boundary.
5. If truncation dropped more than 4 messages, prepend a synthetic summary message (produced by a cheap model call, cached per session, refreshed every 10 dropped messages). The cheap model is `security.budget.degradeTo` when configured, else the primary; the call is charged to the budget, and if it fails the request goes on without a summary.

`maxContextTokens` is derived per model from a small lookup table with a conservative default of 128k for unknown models.

---

## 7. Streaming assembly

`toUIMessageStreamResponse` handles the standard parts. We inject custom parts via the stream writer:

```ts
createUIMessageStream({
  execute: async ({ writer }) => {
    writer.write({
      type: 'data-status',
      transient: true,
      data: { text: 'Searching documentation…' },
    })

    const result = streamText({/* … */})
    writer.merge(result.toUIMessageStream())

    // after retrieval completes, from the tool executor's callback:
    writer.write({ type: 'data-citations', data: { items: citations } })
  },
  onError: (err) => mapError(err), // never leak internals to the browser
})
```

`mapError` is normative: it maps every internal error to `{ code, message, retryable }` from a fixed table. Provider error text, stack traces, file paths, and API keys must never reach the browser. In `logLevel: debug` **and** non-production only, a `detail` field is added.

---

## 8. Cost and usage accounting

Every run reports usage. The engine maintains a `BudgetTracker` per session and per day, backed by the same store as rate limiting.

```ts
interface BudgetTracker {
  session: { tokens: number; usd: number }
  day: { tokens: number; usd: number }
  check(estimate: number): 'ok' | 'degrade' | 'block'
  record(usage: Usage, modelId: string): Promise<void>
}
```

Cost is computed from a per-model price table (`pricing.json`, shipped and overridable via `backend.pricing`). Unknown models record tokens but not USD, and log a one-time warning naming the model — so budgets degrade to token-only rather than silently passing.

Enforcement order per request: **origin → key → rate limit → budget → auth → size**. Cheapest and most-certain rejections first.

---

## 9. Hooks

Available only from `chatbot.config.ts`. All are `async`, all receive `RequestContext`, and all are wrapped so a throwing hook logs and continues rather than killing the request — except `onRequest`, which may deliberately reject.

| Hook               | Signature                           | Use                                          |
| ------------------ | ----------------------------------- | -------------------------------------------- |
| `onRequest`        | `(req, ctx) => void \| Response`    | Custom auth, tenant routing, early rejection |
| `onMessage`        | `(msg, ctx) => UIMessage \| void`   | Rewrite/annotate the inbound message         |
| `onPromptComposed` | `(prompt, ctx) => string \| void`   | Final say on the system prompt               |
| `onToolCall`       | `(call, ctx) => void \| ToolResult` | Audit, or short-circuit with a cached result |
| `onStep`           | `(step, ctx) => void`               | Per-step telemetry                           |
| `onFinish`         | `(result, ctx) => void`             | Persist, analytics, billing                  |
| `onError`          | `(err, ctx) => void`                | Error reporting                              |
| `onFeedback`       | `(feedback, ctx) => void`           | Route thumbs to your own store               |

Details that matter when writing one:

- **`onRequest`** runs in the server adapter after the body has been parsed and validated, so it sees headers and the `RequestContext`, not a readable body.
- **`onToolCall`** sees every *server-side* tool call (http, mcp, module, builtin), after any approval. Client tools run in the browser and never reach it.
- **`onError`** fires once per failed request, or once for an error after output has started. A pre-stream failure that the fallback chain recovers from is not an error, so it isn't reported.
- **`onFinish`** reports usage summed over every step of the run, the same figures budgets are charged.

---

## 10. Testing the engine

| Layer               | Approach                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider resolution | Unit tests per adapter with a stubbed factory; assert lazy import and the install-hint error.                                                        |
| Fallback chain      | `MockLanguageModelV2` scripted to fail with specific status codes; assert retry counts, backoff, hop order, and that mid-stream failures do not hop. |
| Policy resolution   | Table-driven: every `mode` × tool-set combination asserts the resolved policy.                                                                       |
| Prompt composition  | Snapshot tests over the six blocks, including the untrusted-content wrappers.                                                                        |
| Loop                | `MockLanguageModelV2` scripted with tool-call sequences; assert step counts, stop conditions, `onMaxSteps` behaviour.                                |
| Suspend/resume      | Integration: run to an approval gate, assert the checkpoint, resume in a _new_ request, assert continuation and cross-session rejection.             |
| Streaming           | Collect the SSE stream, parse parts, assert ordering invariants (`start` before deltas, `citations` after the tool result, `finish` last).           |
| Budgets             | Fake clock + fake store; assert `degrade` and `block` transitions at boundaries.                                                                     |

**No test in CI may make a real provider call.** A single opt-in `pnpm test:live` suite, gated on env vars, hits real providers for smoke coverage.
