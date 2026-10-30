# Providers and engine

Applications choose the provider and model. Provider adapters support Anthropic, OpenAI, Azure, Google Developer API, Google Vertex, Bedrock, Groq, Mistral, OpenAI-compatible endpoints, Ollama-compatible endpoints, and custom factories where configured. Optional SDKs are installed and declared by the consuming application; importing the framework does not initiate authentication or inference.

The engine resolves `prompt.system` once per incoming generation request, including a resumed request, and reuses the result across model steps, retries and fallback attempts. Trusted instructions and site facts precede separately framed untrusted page context. Tool outputs and source excerpts remain reference data. No framework retrieval policy, search default or knowledge health check exists.

The bounded loop admits only explicitly registered eligible tools. Input and output schemas are validated, including native Zod refinements/transforms. Unknown, disabled, unauthorized, unapproved, or final-step fabricated calls cannot invoke handlers or hooks. The final summary step prohibits tool calls. For Google/Vertex it retains only the current request's eligible application declarations while sending `toolChoice: none`, so the SDK serializes native `toolConfig.functionCallingConfig.mode: NONE`. Removing all declarations would cause the supported Google SDK to omit that setting. The independent execution guard remains disabled on the final step; retaining schemas grants no execution permission. An empty application registry still sends no tool declarations or placeholder tools. Other providers retain the empty final-step declaration list. Session tool caps require an atomic `claimToolCall`; adapters lacking it reject capped configurations instead of approximating the limit.

`backend.timeoutMs` covers each provider invocation's startup and stream consumption, including nonstreaming history summaries. Retries and fallbacks use the selected backend's timeout, private signals, cleanup and late-result suppression. Request cancellation and tool deadlines are cooperative.

A completed turn must have a usable answer, an authorized suspension, or an explicit error. Token/time exhaustion reports `budget_exceeded`; an empty exhausted-step outcome reports `max_steps_exceeded`; an empty completion reports `provider_error`; cancellation reports `aborted`. Errors are localized and finish with an error reason; dangling tool/checkpoint state is settled.

Loop token/time guards evaluate between steps and the final invocation can overshoot. Admission budgets do not reserve spend or provide exactly-once accounting. Concurrent requests to one session retain existing semantics. This cleanup does not redesign those guarantees.

## Lifecycle hooks

`onRequest` may return an early HTTP response. `onMessage` may rewrite an incoming user message. `onToolCall` observes an admitted server call within its permission, argument-validation, approval and deadline boundary; its return value is ignored and the registered handler still executes. A throwing or expired call fails safely. `onStep`, `onFinish`, `onError` and `onFeedback` support observability. Analytics hook errors are logged safely. There is no whole-prompt rewrite hook.

Default tests use deterministic providers and never call paid inference. The production artifact harness uses a synthetic loopback HTTP provider and an ordinary application module handler.
