# Rule-to-test audit

The last item in the v1.0 definition of done ([`09`](./09-implementation-plan.md)) is that every normative
rule in docs 02–08 has at least one test. This page records the audit of 2026-09-25. It lists each rule,
the test that enforces it, what the audit found, and what is still open.

**Statuses:**
- ✅ Covered by a test.
- 🔧 A gap the audit found and fixed: the rule was broken or untested, and it now has a test.
- ⚠️ Open; see [Open tasks](#open-tasks).

Paths are relative to `packages/` unless they start with `e2e/` or `apps/`.

## What the audit changed

The audit found real defects as well as missing tests. Four were security-relevant:

| Finding                                                                                                          | Rule           | Fix                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- |
| A model `{param}` in a header value was accepted if the same value also held a trusted `{{identity.*}}`; header names and the URL scheme were not checked | 05 §2 r2–3, 08 §5 r3 | Config rules `tools/param-in-host`, `tools/param-in-header` and a shared runtime guard |
| Any third-party error with `status: 403/410` was treated as a checkpoint error and its raw message sent to the browser | 04 §7, 08 §2   | `mapError` passes through only `CheckpointError`                      |
| Client-tool results were capped only in the widget and never checked against a schema; a tampered page could send anything to the model | 05 §5 r5       | Server-side 16 KB cap and the new `tools[].outputSchema`              |
| The SSRF guard's pinned DNS lookup ignored `options.all`, so every HTTP tool failed on Node 20+ (found by the example smoke tests) | 08 §5 r5       | `safe-fetch` answers happy-eyeballs lookups                          |

The others were correctness issues:

| Finding                                                                                         | Rule        | Fix                                                                  |
| ----------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| Seven of the eight hooks were accepted by the schema but never called                           | 04 §9       | All eight run; a throwing hook is logged and ignored                 |
| `onFinish` usage was the last step's only, so multi-step runs were budgeted and billed for one step | 04 §8       | `totalUsage`                                                          |
| A deny reached the model without saying the visitor declined                                     | 03 §5 r3    | `execution-denied` with reason `user_denied`                         |
| SSE responses lacked `cache-control: no-transform`                                               | 03 §11      | Header set                                                            |
| Ingest never sent the conditional-GET validators it recorded, so every re-run re-downloaded every page | 06 §3.6 s3  | Validators passed; a 304 keeps the document's chunks                 |
| The script tag's `data-endpoint`/`data-key` were ignored, so a cross-origin embed called its own origin | 07 §2 s1    | `scriptOptions()`; browser test against the sidecar example          |
| Inherited text styles on `<site-chat>` leaked through the shadow root                            | 07 §4, §11  | Pinned with `!important` on `:host`; pixel test with hostile CSS     |
| An unknown `EngineError` code threw inside the error path                                        | 04 §7       | Degrades to `internal_error`                                          |

## 02 — Configuration

| Rule                                                                  | Test                                                                                                   | Status |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| §1 File resolution order, TS before declarative                       | `config/src/schema.test.ts` "resolves TS config files before declarative ones"                         | ✅     |
| §1 `extends` merge semantics (incl. arrays, tools by name, `type` change) | `config/src/merge.test.ts`                                                                          | 🔧     |
| §2 Missing env var is fatal; `:-` default; `prompt.system` and `ui` not interpolated | `config/src/env.test.ts`                                                                | ✅     |
| §2 An env-sourced value never reaches `PublicConfig`                  | `config/src/public.test.ts` "holds for every combination of env-sourced fields"                        | ✅     |
| §5 Composed prompt block order                                        | `core/src/prompt/compose.test.ts` "emits the six blocks in the documented order"                        | ✅     |
| §5 `maxUserMessageChars` hard reject                                  | `core/src/guards/guards.test.ts` "enforces maxUserMessageChars"                                         | ✅     |
| §7 Retrieval default follows mode; `once-per-session` approvals        | `config/src/schema.test.ts`, `core/src/tools.test.ts`                                                  | ✅     |
| §14 Actionable errors; unknown keys with "did you mean"; variant-aware messages | `config/src/errors.test.ts`                                                                   | 🔧     |
| §14 Cross-field rules 1–10                                            | `config/src/cross-field.test.ts`, one `describe` per rule                                               | ✅     |
| §14 JSON Schema published; `init` writes the `$schema` line            | `config/src/json-schema.test.ts`, `cli/src/init.test.ts`                                               | ✅     |
| §14 `validate` masks secrets                                          | `cli/src/validate.test.ts`                                                                             | ✅     |

## 03 — Protocol

| Rule                                                             | Test                                                                                           | Status |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| §1–2 Endpoints, SSE framing, request validation                  | `server/src/conformance.test.ts`                                                               | ✅     |
| §5 r1 Checkpoint bound to session and run; replay is 403          | `core/src/tools.test.ts` "binds state to session/run/id…", "maps replay/expiry statuses"       | ✅     |
| §5 r2 Expired checkpoint → 410 `run_expired`, rendered            | `core/src/tools.test.ts`, `widget/src/panel.test.tsx`                                          | ✅     |
| §5 r3 Deny resumes with `user_denied`                             | `core/src/engine-resume.test.ts` "a deny resumes the model at once…"                            | 🔧     |
| §5 r4 Approved client tool takes two round trips                  | `core/src/engine-resume.test.ts`                                                               | ✅     |
| §5 r5 Pending approval survives a reload                          | `widget/src/chat.test.ts`, `e2e/chat.spec.ts` "a pending approval survives a reload"            | ✅     |
| §6 `/config` returns only documented fields                       | `config/src/public.test.ts`                                                                    | ✅     |
| §7–8 Feedback and health                                          | `server/src/conformance.test.ts`, `e2e/layout.spec.ts`                                          | ✅     |
| §10 Extraction: strip list, widget host excluded, structure, truncation marker, forms outline, selection | `widget/src/context.test.ts`                                         | 🔧     |
| §11 Abort cancels the model call on the server                    | `core/src/engine-resume.test.ts` "the client's abort reaches the model call"                   | 🔧     |
| §11 One silent retry on a drop; server dedupes the resent turn    | `widget/src/chat.test.ts` "network drop…", `core/src/engine.test.ts` "does not double a user turn…" | 🔧 |
| §11 `x-accel-buffering: no`, `cache-control: no-transform`        | `server/src/conformance.test.ts` "POST / streams the answer as SSE"                            | 🔧     |

## 04 — Providers and engine

| Rule                                                              | Test                                                                                         | Status |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| §2 Lazy, optional provider packages with install hints; pass-through ids | `core/src/providers/providers.test.ts`, `core/src/providers/adapters.test.ts`, `server/src/node-runtime.test.ts` | ✅ |
| §3 r1 Backoff 250 ms ×2 ±20%                                       | `core/src/providers/fallback.test.ts`                                                        | 🔧     |
| §3 r2–3 Retry only transient errors; never 4xx, context length, content filter | `core/src/providers/fallback.test.ts`                                            | 🔧     |
| §3 r4 Fallback entries inherit the primary's settings              | `core/src/providers/fallback.test.ts` "resolveChain"                                          | 🔧     |
| §3 r5–7 No hop after the first token; telemetry per hop; 502 when all fail | `core/src/engine.test.ts`                                                             | ✅     |
| §4 Policy, stop conditions, `onMaxSteps`                           | `core/src/agent/policy.test.ts`                                                              | ✅     |
| §6 r1–2 Only the last user message is trusted                      | `core/src/engine.test.ts` "trusts only the last user message from the body"                   | ✅     |
| §6 r3–4 Truncate to the budget at a clean boundary; tool pairs intact | `core/src/session/truncate.test.ts`                                                       | 🔧     |
| §6 r5 Synthetic summary when more than 4 messages are dropped, cached, refreshed every 10 | `core/src/engine.test.ts` "history summary" | 🔧 |
| §7 `mapError`: fixed table, no provider text, detail only in debug and non-production | `core/src/stream/errors.test.ts`                                           | 🔧     |
| §8 Usage and cost over every step                                   | `core/src/engine.test.ts` "onStep and onFinish report steps, usage and the model"            | 🔧     |
| §9 Hooks: all eight, isolation of a throwing hook                   | `core/src/engine.test.ts` "hooks", `server/src/hooks.test.ts`                                 | 🔧     |

## 05 — Tools

| Rule                                                                   | Test                                                                                        | Status |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| §1 Names unique and well-formed                                        | `config/src/cross-field.test.ts`, `config/src/schema.test.ts`                                | ✅     |
| §1 r1 Failures reach the model as data (`tool_failed`)                 | `core/src/engine.test.ts` "turns an executor failure into tool_failed…"                     | 🔧     |
| §1 r2 Arguments re-validated server-side (`invalid_input`)             | `core/src/engine.test.ts` "re-validates model arguments…"                                   | 🔧     |
| §2 r1 Percent-encoding                                                 | `core/src/tools.test.ts` "percent-encodes path parameters…"                                  | ✅     |
| §2 r2–3 No model parameter in scheme, host or headers                  | `config/src/cross-field.test.ts` "http tool templating", `core/src/tools.test.ts`            | 🔧     |
| §2 r4–5 Host allowlist; private ranges refused                         | `core/src/tools.test.ts`, `core/src/security.security.test.ts`                               | ✅     |
| §2 r6 Response size cap                                                | `core/src/tools.test.ts` "caps responses…"                                                  | ✅     |
| §3 MCP: `allow` warning, framing, pooling, reconnect, stdio not on edge, size cap | `core/src/mcp.test.ts`, `config/src/cross-field.test.ts`                            | ✅     |
| §5 r1 Server allowlist wins                                            | `widget/src/client-tools.test.ts`, `widget/src/chat.test.ts`                                | ✅     |
| §5 r2 Navigate restricted to routes                                    | `widget/src/client-tools.test.ts`, `core/src/tools.test.ts`                                  | ✅     |
| §5 r3 `fill_form` never submits; per-field verification                | `widget/src/client-tools.test.ts`, `e2e/chat.spec.ts`                                        | ✅     |
| §5 r4 Read-selector denylist                                           | `widget/src/client-tools.test.ts`                                                           | ✅     |
| §5 r5 16 KB cap and output schema, enforced on the server              | `core/src/engine-resume.test.ts` "client tool results from the browser"                      | 🔧     |
| §5 r6 Every client tool call shows a chip                              | `widget/src/panel.test.tsx`                                                                 | ✅     |
| §5 r7–8 Approval gate for writable client tools; name → id mapping     | `core/src/engine-resume.test.ts`, `widget/src/client-tools.test.ts`                          | ✅     |
| §7 r1–2 Approval binding; per-argument-hash grants                     | `core/src/tools.test.ts`                                                                    | ✅     |
| §7 r3 Enter never approves                                             | `widget/src/panel.test.tsx`, `e2e/behaviour.spec.ts`                                         | ✅     |
| §7 r5 `approvalPolicy: never` still warns                              | `config/src/cross-field.test.ts`                                                            | ✅     |

## 06 — Knowledge

| Rule                                                              | Test                                                                                 | Status |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| §2 Page context never sent when `includePageContext: false`        | `core/src/prompt/compose.test.ts`                                                    | ✅     |
| §3.5 Model recorded in the manifest; a mismatch refuses incremental runs | `ingest/src/pipeline.test.ts` "model mismatch error text names --force"      | ✅     |
| §3.6 s2 Unchanged documents cost no embedding calls                | `ingest/src/pipeline.test.ts`                                                        | ✅     |
| §3.6 s3 Conditional GET with the recorded validators               | `ingest/src/pipeline.test.ts` "re-fetches a sitemap page conditionally…"             | 🔧     |
| §3.6 s4 Only changed *chunks* re-embedded                           | `ingest/src/pipeline.test.ts` "re-embeds only changed chunks"                         | ✅     |
| §3.6 s5–6 Removed documents lose their chunks; atomic manifest      | `ingest/src/pipeline.test.ts`                                                        | ✅     |
| §3.7 Unreachable store → degraded, chat continues                   | `core/src/engine-knowledge.test.ts`                                                  | ✅     |
| §3.8 Retrieval: `minScore` note, neighbours, dedupe, recall          | `core/src/knowledge/golden-retrieval.test.ts`, `store-conformance.test.ts`            | ✅     |
| §3.9 Numbered citations; chips show only cited sources; `citation-click` | `core/src/prompt/compose.test.ts`, `widget/src/citations.test.ts`, `widget/src/element-api.test.tsx` | 🔧 |

## 07 — Widget

| Rule                                                             | Test                                                                                 | Status |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| §1 Bundle budgets                                                | `size-limit` in CI                                                                   | ✅     |
| §2 s1 The script tag's `data-*` configure the widget              | `widget/src/index.test.ts`, `e2e/sidecar.spec.ts`                                     | 🔧     |
| §2 Double inclusion is safe; calls before boot are queued         | `e2e/behaviour.spec.ts`, `widget/src/element.test.tsx`                                | ✅     |
| §4 Host CSS cannot reach the widget                               | `e2e/visual.spec.ts` "hostile host CSS", `widget/src/styles.test.ts`                  | 🔧     |
| §4 Contrast validated in both themes                              | `widget/src/styles.test.ts`, `e2e/a11y.spec.ts`                                       | ✅     |
| §5–6 Keyboard, mobile sheet, scroll lock, focus trap              | `widget/src/panel.test.tsx`, `e2e/layout.spec.ts`                                     | ✅     |
| §7 States, including "Still working…" and stop                    | `widget/src/panel.test.tsx`, `e2e/chat.spec.ts`                                       | ✅     |
| §8 axe-core clean in every state and theme                        | `e2e/a11y.spec.ts`                                                                   | ✅     |
| §9 `identify()` token kept in memory only                          | `widget/src/chat.test.ts` "identity"                                                 | 🔧     |
| §9 History persistence namespaced by public key, capped at 50      | `widget/src/chat.test.ts`, `widget/src/index.test.ts`                                 | ✅     |
| §10 Error table; provider text never shown; never throws into the host | `widget/src/chat.test.ts`, `widget/src/panel.test.tsx`, `widget/src/element-api.test.tsx` | ✅ |
| §11 Visual baselines, 4 viewports × 2 themes                       | `e2e/visual.spec.ts`                                                                 | ✅     |
| §11 Tailwind/Bootstrap fixtures, SPA fixture, resume-after-drop in a browser, screen-reader script | One hostile stylesheet stands in for the CSS fixtures; the rest are unit-level or manual | ⚠️ 3 |

## 08 — Security

| Rule                                                              | Test                                                                                   | Status |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| §2 Keys never in logs, the browser or errors                       | `core/src/telemetry/logger.test.ts`, `config/src/public.test.ts`, `core/src/stream/errors.test.ts` | 🔧 |
| §3 JWT: signature, `iss`/`aud`, `exp` and max age, clock tolerance, `claimsMap`, session binding | `core/src/security.security.test.ts`                         | ✅     |
| §4 Untrusted content framed and placed after the trusted blocks    | `core/src/security.security.test.ts`, `core/src/prompt/compose.test.ts`                 | ✅     |
| §5 r1–4 Re-validation, encoding, no parameters in host or headers, allowlist | see 05 §1–2                                                                   | 🔧     |
| §5 r5 Private ranges refused after DNS resolution (rebinding)       | `core/src/tools.test.ts` "…DNS rebinding", `core/src/node/safe-fetch.test.ts`           | 🔧     |
| §5 r6–8 Redirects off by default and re-checked per hop; content-type and size caps; timeouts | `core/src/tools.test.ts` "redirects and content types", "caps responses…"; `core/src/security.security.test.ts` | 🔧 |
| §6 Session fingerprint; forged history refused                      | `core/src/security.security.test.ts`, `core/src/engine.test.ts`                         | ✅     |
| §7 Origins: empty = same-origin, no wildcard, no credentials header | `config/src/cross-field.test.ts`, `server/src/conformance.test.ts`                      | ✅     |
| §8 Rate limits and budgets                                          | `core/src/guards/guards.test.ts`, `core/src/security.security.test.ts`                  | ✅     |
| §8 Request size limits                                              | `core/src/guards/guards.test.ts`, `server/src/conformance.test.ts`                      | ✅     |
| Deployment checklist enforced by `doctor --production`              | `cli/src/doctor.security.test.ts`, `apps/docs/test/docs.test.ts`                        | ✅     |

## Open tasks

1. **Browser coverage still missing (07 §11).** Tailwind and Bootstrap fixture pages (one maximally
   hostile stylesheet covers the mechanism today), an SPA fixture for `refreshPageContext`, a browser
   test for resume-after-drop (unit-tested in `widget/src/chat.test.ts`), and the manual screen-reader
   script.
