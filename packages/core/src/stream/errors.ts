/**
 * `mapError` is normative — docs/04-providers-and-engine.md §7.
 *
 * Every internal failure becomes one of a fixed set of codes. Provider error
 * text, stack traces, file paths and API keys must never reach the browser, so
 * the mapping is *closed*: an unrecognised error becomes `internal_error` with
 * a generic message rather than falling through to `error.message`.
 */

export const ERROR_CODES = [
  'invalid_request',
  'auth_required',
  'origin_denied',
  'invalid_key',
  'payload_too_large',
  'rate_limited',
  'budget_exceeded',
  'provider_error',
  'not_ready',
  'max_steps_exceeded',
  'aborted',
  'internal_error',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorSpec {
  status: number
  message: string
  retryable: boolean
}

/** The fixed table. Messages are user-facing: no jargon, no internals. */
export const ERROR_TABLE: Record<ErrorCode, ErrorSpec> = {
  invalid_request: {
    status: 400,
    message: 'That request could not be understood.',
    retryable: false,
  },
  auth_required: { status: 401, message: 'Please sign in to continue.', retryable: false },
  origin_denied: {
    status: 403,
    message: 'This assistant is not available on this site.',
    retryable: false,
  },
  invalid_key: {
    status: 403,
    message: 'This assistant is not configured correctly for this site.',
    retryable: false,
  },
  payload_too_large: { status: 413, message: 'That message is too large.', retryable: false },
  rate_limited: {
    status: 429,
    message: 'Too many messages just now. Please wait a moment and try again.',
    retryable: true,
  },
  budget_exceeded: {
    status: 402,
    message: 'The assistant has reached its usage limit for now.',
    retryable: false,
  },
  provider_error: {
    status: 502,
    message: 'The assistant is having trouble responding. Please try again.',
    retryable: true,
  },
  not_ready: { status: 503, message: 'The assistant is not ready yet.', retryable: true },
  max_steps_exceeded: {
    status: 500,
    message: 'The assistant took too many steps and stopped.',
    retryable: true,
  },
  aborted: { status: 499, message: 'The request was cancelled.', retryable: false },
  internal_error: { status: 500, message: 'Something went wrong.', retryable: true },
}

export interface MappedError {
  code: ErrorCode
  message: string
  retryable: boolean
  /** Only ever populated in debug + non-production. Never sent otherwise. */
  detail?: string
}

export interface EngineErrorOptions {
  /** Overrides the table's user-facing message. Still never contains internals. */
  message?: string
  /** Internal detail: logged always, returned only in debug + non-production. */
  detail?: string
  cause?: unknown
  /** Extra response headers, e.g. `Retry-After` on a 429. */
  headers?: Record<string, string>
}

/** The one error type the engine throws deliberately. */
export class EngineError extends Error {
  override readonly name = 'EngineError'
  readonly code: ErrorCode
  readonly status: number
  readonly retryable: boolean
  readonly detail: string | undefined
  readonly headers: Record<string, string>

  constructor(code: ErrorCode, options: EngineErrorOptions = {}) {
    const spec = ERROR_TABLE[code]
    super(options.message ?? spec.message, { cause: options.cause })
    this.code = code
    this.status = spec.status
    this.retryable = spec.retryable
    this.detail = options.detail
    this.headers = options.headers ?? {}
  }
}

export interface MapErrorOptions {
  /** `telemetry.logLevel === 'debug'`. */
  debug?: boolean
  /** `NODE_ENV === 'production'` — detail is withheld in production regardless. */
  production?: boolean
}

function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Map anything thrown anywhere into the fixed table.
 *
 * The `detail` field exists so a developer debugging locally is not flying
 * blind, and it is gated on *both* `logLevel: debug` and non-production so that
 * turning up log verbosity on a live site cannot start leaking provider bodies.
 */
export function mapError(error: unknown, options: MapErrorOptions = {}): MappedError {
  const code: ErrorCode =
    error instanceof EngineError ? error.code : isAbort(error) ? 'aborted' : 'internal_error'
  const spec = ERROR_TABLE[code]

  const mapped: MappedError = {
    code,
    message: error instanceof EngineError ? error.message : spec.message,
    retryable: spec.retryable,
  }

  if (options.debug === true && options.production !== true) {
    const detail =
      error instanceof EngineError
        ? (error.detail ?? error.message)
        : error instanceof Error
          ? error.message
          : String(error)
    mapped.detail = detail
  }

  return mapped
}

/** Render a mapped error as the pre-stream JSON response of docs/03 §2. */
export function errorResponse(error: unknown, options: MapErrorOptions = {}): Response {
  const mapped = mapError(error, options)
  const status = error instanceof EngineError ? error.status : ERROR_TABLE[mapped.code].status
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(error instanceof EngineError ? error.headers : {}),
  }
  // 499 is nginx's client-closed code and is not a legal HTTP status to send.
  return new Response(JSON.stringify(mapped), {
    status: status === 499 ? 400 : status,
    headers,
  })
}
