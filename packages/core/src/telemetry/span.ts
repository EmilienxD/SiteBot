/**
 * OTel spans without an OTel dependency.
 *
 * `@sitebot/core` must build for the edge and carry very few runtime deps
 * (docs/08-security.md §11), so we do not import `@opentelemetry/api`. Instead a
 * tracer is *injected*: a host that already runs OTel passes an adapter in
 * `EngineDeps.tracer`, and everyone else pays nothing. The AI SDK's own
 * `experimental_telemetry` handles the model call itself.
 */

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void
  recordError(error: unknown): void
  end(): void
}

export interface Tracer {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span
}

const noopSpan: Span = {
  setAttribute: () => {},
  recordError: () => {},
  end: () => {},
}

export const noopTracer: Tracer = {
  startSpan: () => noopSpan,
}

/**
 * Run `fn` inside a span, ending it exactly once whichever way `fn` exits.
 * The error is recorded and rethrown — a span must never swallow a failure.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const span = tracer.startSpan(name, attributes)
  try {
    return await fn(span)
  } catch (error) {
    span.recordError(error)
    throw error
  } finally {
    span.end()
  }
}

/** An in-memory tracer that records what happened. Test-only, exported for reuse. */
export function createRecordingTracer(): Tracer & {
  spans: { name: string; attributes: Record<string, unknown>; errors: unknown[]; ended: boolean }[]
} {
  const spans: {
    name: string
    attributes: Record<string, unknown>
    errors: unknown[]
    ended: boolean
  }[] = []

  return {
    spans,
    startSpan(name, attributes = {}) {
      const record = { name, attributes: { ...attributes }, errors: [] as unknown[], ended: false }
      spans.push(record)
      return {
        setAttribute: (key, value) => {
          record.attributes[key] = value
        },
        recordError: (error) => {
          record.errors.push(error)
        },
        end: () => {
          record.ended = true
        },
      }
    },
  }
}
