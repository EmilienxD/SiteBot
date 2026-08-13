Below are copy-pasteable prompts, one per fix, scoped to **unit tests only (Vitest) — no Playwright, no e2e**. 

**Sequencing matters:** Fix 1 rewrites 68 files and will conflict with everything, so run it alone and first. After that, Wave 2 (all widget files) should run serially or with careful file partitioning; Waves 3–4 are independent and parallelisable.

---

# Wave 1 — get CI green

### Fix 1 — Prettier (run alone, first)

```
The repo's own CI step `pnpm format:check` fails on 68 files (core 22, cli 18,
widget 13, ingest 9, server 4, react 1, config 1). Much of the source is written
one-statement-per-line in a dense style that .prettierrc.json rejects.

Run `pnpm format` to reformat, then verify `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, and `pnpm test:security` all still pass.

This is a formatting-only change: do not alter behaviour, rename anything, or
"clean up" logic while you are in these files. If Prettier's output changes a
line in a way that looks semantically meaningful, stop and report it rather
than hand-editing around it.
```

### Fix 2 — Flaky boundaries test

```
test/boundaries.test.ts:32 ("rule 1: config may not import core") intermittently
fails with "Test timed out in 5000ms". It runs ESLint programmatically; on a cold
ESLint cache it takes ~9s, on a warm one ~600ms. It passes on re-run, so it will
fail intermittently in CI.

Fix it so the suite is deterministic. Preferred: hoist the ESLint instance
construction into a `beforeAll` shared across the 13 tests and give that hook
(or the project) an explicit timeout with headroom — do not just bump the global
testTimeout blindly.

Verify by running `npx vitest run --project=boundaries` twice: once after
deleting the ESLint cache, once warm. Both must pass. Unit tests only.
```

### Fix 3 — Widget bundle budget (2.7× over)

```
`pnpm size` fails — a CI step and a docs/09 v1.0 definition-of-done item:
  launcher (initial): 67.66 kB gzip vs 12 kB limit
  total:              67.66 kB gzip vs 25 kB limit
Both entries report the same number because there is only one chunk.

Root cause: packages/widget/src/element.tsx:22 statically imports `Panel`, so the
lazy panel chunk that docs/07 §1 specifies does not exist ("The panel's Preact
tree is lazy — only the launcher renders until first open, then the chat chunk is
dynamically imported. First paint cost is a button."). The `ai` package
(AbstractChat, DefaultChatTransport, imported via chat.ts) lands in the initial
payload. Preact + @preact/signals is only ~6 kB of the total.

Split the bundle so the launcher chunk contains the custom element, styles, and
launcher render path only, and the panel + chat controller + `ai` transport load
via dynamic import on first open. Budgets from docs/07 §1: launcher <= 12 kB,
panel <= 18 kB, total <= 25 kB gzip. Update the size-limit entries in
packages/widget/package.json so each budget points at its own chunk instead of
both pointing at the same file.

Add unit tests (jsdom, packages/widget/src/**/*.test.ts) asserting the element
boots and renders the launcher without the panel module being evaluated, and
that opening resolves the dynamic import and mounts the panel. Unit tests only —
no Playwright. Verify with `pnpm --filter @sitebot/widget size`.
```

---

# Wave 2 — widget correctness

### Fix 4 — Markdown renderer

```
packages/widget/src/markdown.tsx is broken and incomplete. Verified actual output:

  "**bold** text"      -> <p><strong>bold</strong>* text</p>   (stray asterisk)
  "```js\nconst a=1\n```" -> <p>``<code>js const a=1 </code>``</p>  (mangled)
  "- one\n- two"       -> <p>- one - two</p>                   (literal text)
  "> quoted"           -> <p>&gt; quoted</p>                   (literal text)
  "# Title"            -> <p># Title</p>                       (literal text)

The bold bug is the alternation `\*\*([^*]+)\*` — it consumes only one closing
asterisk. docs/07 §5 requires: paragraphs, bold/italic, inline code, fenced code
with horizontal scroll, links (rel="noopener noreferrer" target="_blank"),
ordered/unordered lists, and blockquote.

Implement the missing block types and fix bold. Keep it a whitelist renderer
that emits only the allowed node types and never raw HTML — docs/07 §5 calls this
an XSS boundary, not a styling choice. Budget is ~3 KB per docs/07 §1, so no
marked/remark. Add the fenced-code horizontal-scroll style to styles.ts.

The existing XSS test (security.security.test.tsx) must keep passing unchanged.
Add unit tests covering each supported block and inline type plus the bold
regression. Unit tests only.
```

### Fix 5 — Browser JS API surface

```
docs/03 §9 specifies the `window.SiteBot` API. Missing from
packages/widget/src/index.ts, element.tsx, chat.ts and types.ts:

  destroy(), isOpen(), setSuggestions(items), clearIdentity(),
  setContext(data), send(text, { hidden }), and the `ready` promise
  and `version` string properties.

`setContext(data)` merges into pageContext.custom — docs/03 §2 shows
`pageContext.custom` on the wire, and packages/widget/src/types.ts PageContext
has no `custom` field, so add it and thread it through
context.ts extractPageContext and chat.ts's prepareSendMessagesRequest.

Also: docs/03 §9 lists nine events; only open, close, error, reset and
citation-click currently fire. Add ready, message, tool, approval, handoff and
feedback with the payload shapes in the §9 table.

Every method must stay safe to call before boot — index.ts already has the
queueing mechanism, extend it rather than replacing it. Every entry point stays
wrapped so the widget never throws into the host page (docs/07 §10).

Add unit tests (jsdom) for the queued-before-boot path, each new method, and each
new event firing with the documented payload. Unit tests only.
```

### Fix 6 — State machine and degradation

```
docs/07 §7 and §10 specify widget states and failure handling. Missing from
packages/widget/src/chat.ts and panel.tsx:

- `executing-client-tool` state (WidgetState in types.ts has only idle,
  submitted, streaming, awaiting-approval, error).
- The 4-second "Still working…" affordance on `submitted` (docs/07 §7: "if no
  token arrives within 4 s it adds 'Still working…'. Never a dead input").
- 429: error bubble with a Retry-After countdown, composer disabled until it
  elapses.
- budget_exceeded: friendly message from config, composer disabled.
- Provider down: "I'm having trouble right now" + Retry; underlying error never
  shown.
- Network drop mid-stream: one automatic `resume` retry, then an error bubble
  with a manual Retry. The resume payload builder already exists in chat.ts
  (`resumePayload`) — reuse it.
- Error bubbles currently have no Retry affordance at all.

Per-state composer/send-button affordances are tabulated in docs/07 §7; match
that table.

Add unit tests (jsdom) driving the controller through each transition with a
stubbed transport, including the 429 countdown and the single-retry-then-give-up
path. Unit tests only.
```

### Fix 7 — Message rendering fidelity

```
packages/widget/src/panel.tsx deviates from the docs/07 §3 component tree and
§5 layout rules:

- Tool chips and approval cards render as flat lists after ALL messages
  (panel.tsx:133-134, `controller.messages.flatMap(...)`) instead of inline
  within the message they belong to. A tool chip from an early message currently
  appears at the bottom of the transcript.
- Attribution renders under every assistant bubble. docs/07 §5: "Only rendered
  on the assistant's last bubble in a consecutive run, so a multi-part answer
  shows one attribution rather than three."
- No consecutive-same-role grouping. docs/07 §5: same-role bubbles collapse to
  `--sb-gap / 2` spacing, role changes use `--sb-gap * 1.5`. styles.ts currently
  hardcodes `margin: 0 0 14px`.
- The launcher icon is the literal string 'AI' / 'Chat' / '?'
  (element.tsx:83, `function icon()`). Replace with inline SVG glyphs.
- Mobile sheet must set aria-modal="true" (panel.tsx hardcodes "false") and lock
  body scroll while open; focus is trapped in the mobile sheet per docs/07 §8.
  The approval card focus trap already exists — follow that pattern.

Add unit tests (jsdom) for chip/card placement relative to their message,
last-in-run attribution, grouping classes, and the mobile aria-modal/scroll-lock
branch driven by a matchMedia stub. Unit tests only.
```

### Fix 8 — Honour ignored config keys

```
Seven resolved `ui.*` config keys are read into packages/widget/src/defaults.ts
and then never used anywhere in the widget:

  showReasoning, resetOnNavigate, emptyStateAfterMs, sound,
  allowFileUpload, strings (i18n overrides), isolation

(`isolation` is Fix 9 — leave it out of scope here.) Implement the other six:

- showReasoning: render `reasoning` parts as a collapsed "Thinking" disclosure
  (docs/03 §3 part table), hidden when false.
- resetOnNavigate: clear the conversation on host-page navigation.
- emptyStateAfterMs: the empty-state affordance timing.
- sound: notification sound on assistant response.
- allowFileUpload: composer attachment affordance, gated on
  capabilities.fileUpload from the server.
- strings: string-table overrides applied to user-visible copy.

If any of these is genuinely out of scope for v1, say so explicitly and remove
the key from the schema rather than leaving config that silently does nothing —
do not leave a third state where the config validates but has no effect.

Add unit tests (jsdom) asserting each key changes observable behaviour in both
its on and off position. Unit tests only.
```

### Fix 9 — `ui.isolation: iframe`

```
docs/07 §2 specifies an `iframe` isolation mode: the panel swaps into a
same-origin `<iframe srcdoc>` with postMessage bridging, for sites whose CSP
forbids inline styles or whose JS is hostile. The launcher stays in the shadow
root either way, and client tools still work — the bridge forwards them to the
parent frame.

packages/widget/src/element.tsx always calls attachShadow and renders the panel
inline; `config.ui.isolation` is never read. The schema accepts the value, so
this config validates today and does nothing.

Implement the iframe path behind that config value, including the postMessage
bridge for client-tool execution in the parent frame (client tools need real
parent-document DOM access — see packages/widget/src/client-tools.ts).

Add unit tests (jsdom) for the srcdoc mount, the bridge round-trip, and that a
client tool invoked inside the iframe executes against the parent document.
Unit tests only.
```

### Fix 10 — Suggestion `tool` action

```
docs/07 §5 tabulates four suggestion action types: send, navigate, tool, link.
packages/widget/src/panel.tsx:187 (`function suggestion`) handles send, navigate
and link. `tool` falls through silently — the pill renders and clicking it does
nothing.

Per the docs table, `tool` "Invokes a named tool via a hidden user turn". Note
this depends on the `hidden` option of send() — coordinate with Fix 5, which
adds `send(text, { hidden })`, or implement the hidden-turn path here if Fix 5
has not landed.

Add a unit test per action type, including the tool case asserting a hidden turn
is dispatched and no user bubble is rendered. Unit tests only.
```

### Fix 11 — Widget test coverage

```
packages/widget is at 24.4% statement coverage. Uncovered:
  chat.ts       0%    (controller, transport wiring, suspend/resume payloads)
  panel.tsx    10%
  context.ts    2%    (page-context extraction)
  storage.ts   21%
  defaults.ts  25%
packages/react is at 7.7%.

Write unit tests (Vitest + jsdom) for these. Priority order, targeting the
riskiest logic rather than raw percentage:

1. context.ts extractPageContext — the 6-step algorithm in docs/03 §10:
   selector fallback, strip lists, heading/list-marker preservation, 4000-char
   sentence-boundary truncation with "…[truncated]", selection capture, and the
   hash-unchanged path that sends extractHash instead of extract.
2. chat.ts resumePayload — approvals and clientToolResults extraction from the
   last step, runId resolution, and the clientTools allowlist filter.
3. storage.ts — namespacing, and the private-mode fallback to in-memory
   (docs/07 §10: localStorage unavailable must not throw).
4. panel.tsx render paths and packages/react ChatWidget mount/configure.

Do not lower the bar to hit a number: assert behaviour described in docs/03 §10
and docs/07 §9. Unit tests only — no Playwright.
```

---

# Wave 3 — backend gaps

### Fix 12 — Six missing data parts

```
docs/03 §4 specifies nine custom data parts. packages/core/src/engine.ts emits
only three: data-citations, data-approval-request, data-client-tool-call.

Missing, with payloads and widget behaviour in the §4 table:
  data-suggestions  { items: [{ label, action }] }        replaces the pill row
  data-navigate     { path, newTab }                      navigates the host page,
                                                          only to siteContext.routes
  data-handoff      { target, ticketUrl?, message }        handoff card
  data-status       { text }                              transient status line
  data-error        { code, message, retryable }          inline error + Retry
  data-usage        { inputTokens, outputTokens, costUsd } debug overlay only

data-status and data-client-tool-call are transient (transient: true) and must
not persist into message history.

Emit them from the engine and handle them in packages/widget/src/chat.ts onData
plus the corresponding panel.tsx rendering. data-navigate and data-handoff pair
with Fix 13 — coordinate if both are in flight.

Add unit tests in packages/core (MockLanguageModelV2, no network) asserting each
part is emitted with the documented shape and that transient parts are absent
from persisted history; add jsdom tests for the widget-side handling.
Unit tests only.
```

### Fix 13 — Builtin tool stubs

```
docs/05 §4 lists eight builtin tools. In
packages/core/src/tools/registry.ts:256-270, three are stubs or missing:

- `navigate` (line 256) echoes the path back to the model and never emits
  data-navigate, so the host page never moves. Docs: "Send the host page to a
  declared route. Client-side effect via data-navigate." Must be restricted to
  siteContext.routes.
- `handoff` (line 263) returns { accepted: true, target, message } without
  calling anything. Docs/05 §4 requires emitting data-handoff and supporting
  target.kind of webhook | intercom | crisp | zendesk | email | url with
  includeTranscript. docs/00 §4 names this tool as the reason we do not build a
  live-chat console, so it is load-bearing.
- `collect_lead` is in BUILTIN_TOOL_IDS (packages/config/src/schema/tools.ts:22)
  with no implementation — it falls through to the default branch and returns
  { error: 'not_configured' } at runtime. Docs: "Structured capture of
  name/email/company into the events webhook." Config accepts it today and the
  tool silently fails.

Also review `submit_feedback` (line 254): it returns { accepted: true } and
dispatches nothing, while POST /feedback in packages/server/src/handler.ts does
dispatch to telemetry.events.webhook and the onFeedback hook. Make them
consistent.

Add unit tests against a stub webhook and a stubbed dispatcher for each tool,
including the navigate route restriction and handoff transcript inclusion.
Unit tests only.
```

### Fix 14 — `/config` pending approval probe

```
docs/03 §5 rule 4: "Because state lives in the session store, the user can reload
the page and still resume — the widget rehydrates pending approvals from
GET /api/chat/config's session probe." docs/03 §6 shows the `pending` field
carrying { runId, approval: {...} }.

Not implemented. packages/server/src/handler.ts:328 handleConfig reads
`sessionId` only to switch Cache-Control to private/no-store — the comment at
line 326 even says "Phase 5's approval probe" — and engine.getPublicConfig()
(packages/core/src/engine.ts:629, typed in types.ts:116) takes no session
argument, so nothing can surface it.

The checkpoint machinery underneath is real and already tested
(packages/core/src/agent/checkpoint.ts, loadPendingRun/savePendingRun). Wire it
through: extend getPublicConfig to accept an optional sessionId and return
`pending` when a live, unexpired checkpoint exists. Keep the existing
cache-control behaviour — a response carrying `pending` must never land in a
shared cache. Then rehydrate it widget-side in element.tsx's fetchConfig path so
a reload re-renders the approval card.

This closes the "page-reload-then-resume" case in the Phase 5 acceptance
criteria. Add unit tests: pending present/absent, expired checkpoint omitted,
cross-session sessionId does not leak another session's pending approval, and
the cache-control header in both branches. Unit tests only.
```

---

# Wave 4 — test debt

### Fix 15 — Prompt composition tests

```
packages/core/src/prompt/compose.ts is 268 lines at 62% coverage with a single
indirect assertion in engine.test.ts ("sends the composed system prompt to the
model"). prompt/variables.ts is at 40%. There is no prompt test file at all.

docs/09 Phase 2 acceptance: "Prompt composition snapshot tests pass for all six-
block permutations."

Write packages/core/src/prompt/compose.test.ts covering the six ordered blocks
from docs/04 §5, their presence/absence permutations, {{variables}} substitution
(prompt/variables.ts), and the untrusted-content framing (prompt/untrusted.ts —
note the randomised-delimiter behaviour is already partly covered in
security.security.test.ts; do not duplicate, cover the composition side).

Snapshot the composed output. Cover the ordering explicitly — docs/04 §5 notes
the block order is designed for prompt-cache breakpoint placement, so a
reordering regression must fail a test. Unit tests only.
```

### Fix 16 — Policy and stop-condition tests

```
packages/core/src/agent/policy.ts is at 33% statement coverage. Lines 49-62 —
the entire agent branch of resolvePolicy — are uncovered, as are the
tokenBudgetIs and wallClockIs stop conditions.

docs/09 calls resolvePolicy "the only `mode` branch" and lists it plus the stop
conditions (stepCountIs, tokenBudgetIs, wallClockIs, onMaxSteps: summarize) as
Phase 5 deliverables.

Write packages/core/src/agent/policy.test.ts covering both mode branches, each
stop condition at and either side of its boundary, and the
onMaxSteps: 'summarize' path including summarizeAtStep computation
(policy.ts:66-67) and its consumption in engine.ts:295-299.

Unit tests only, no network — use MockLanguageModelV2 where a model is needed.
```

### Fix 17 — Golden retrieval set

```
docs/09 Phase 6 acceptance: "Ingest the playground site; a golden set of 20
query -> doc pairs holds recall@6 above threshold." Nothing like it exists.

This is unit-testable without infrastructure: apps/playground has real content
(/, /docs, /pricing, /support) and packages/core/src/knowledge/memory-store.ts
plus a deterministic stub embedder are enough — see the existing stub patterns
in packages/core/test/helpers.ts and packages/ingest/src/pipeline.test.ts, which
already achieves "zero embedding calls" assertions without a provider.

Build a fixture corpus from the playground content, define 20 query -> expected-
doc pairs, and assert recall@6 stays above an explicit committed threshold. Make
the threshold a named constant with a comment explaining what regression it
guards, so a future chunking or retrieval change fails loudly rather than
silently degrading answer quality.

Unit tests only. No real embedding calls — docs/09 hard rule: no test in the
default CI pipeline makes a real network call to a provider.
```

### Fix 18 — Missing fallback cases

```
docs/09 Phase 2 acceptance requires fallback tests covering four cases:
retry-then-succeed, retry-exhausted-then-hop, non-retryable-no-retry, and
mid-stream-no-hop.

packages/core/src/engine.test.ts "fallback (docs/04 §3)" covers three:
hop-before-first-token, non-retryable, and all-entries-fail-502. Missing:

- retry-then-succeed: a retryable error that succeeds on retry within the same
  provider entry, without hopping.
- mid-stream-no-hop: a failure after the first token must NOT hop to the next
  provider — docs/04 §3 makes hopping pre-first-token-only, and
  packages/core/src/providers/fallback.ts:10 notes it becomes a retryable
  data-error part instead.

Add both to the existing describe block using MockLanguageModelV2. Also assert
the `provider_fallback` telemetry event fires on a hop. Unit tests only, no
network.
```

### Fix 19 — CLI test stdout leak

```
Running `pnpm test` prints interactive prompt output into the test log:

    Name (default): Anthropic
    Choose 1-2: 2
    Continue? (y/N): y

A CLI test is writing to the real process stdout instead of an injected stream.
Find it in packages/cli/src (start with init.test.ts, init-validate.e2e.test.ts
and prompt.ts) and inject a writable stream or spy so the test asserts on
captured output rather than leaking to the terminal.

While there: packages/cli/src/init/site-draft.ts is at 2% coverage and
commands/doctor.ts at 41%. Add unit tests for site-draft's homepage-fetch-and-
draft path with a stubbed fetch (no real network), since that is the step
`sitebot init` depends on to produce a site-aware config.

Unit tests only.
```

---

**Not covered above:** Phase 10 (3 of 4 examples, `apps/docs`, recipes, generated config reference) is unstarted work rather than a fix, so it needs its own scoping pass — and its acceptance criterion ("every example runs from a clean clone with only an API key set") is inherently not unit-testable.