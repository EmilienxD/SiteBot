import { en, createTranslator, type LocaleConfig, type MessageKey } from '@sitebot/config/i18n'

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
    message: en.invalid_request,
    retryable: false,
  },
  auth_required: { status: 401, message: en.auth_required, retryable: false },
  origin_denied: {
    status: 403,
    message: en.origin_denied,
    retryable: false,
  },
  invalid_key: {
    status: 403,
    message: en.invalid_key,
    retryable: false,
  },
  payload_too_large: { status: 413, message: en.payload_too_large, retryable: false },
  rate_limited: {
    status: 429,
    message: en.rate_limited,
    retryable: true,
  },
  budget_exceeded: {
    status: 402,
    message: en.budget_exceeded,
    retryable: false,
  },
  provider_error: {
    status: 502,
    message: en.provider_error,
    retryable: true,
  },
  not_ready: { status: 503, message: en.not_ready, retryable: true },
  max_steps_exceeded: {
    status: 500,
    message: en.max_steps_exceeded,
    retryable: true,
  },
  aborted: { status: 499, message: en.aborted, retryable: false },
  internal_error: { status: 500, message: en.internal_error, retryable: true },
}

export interface MappedError {
  messageKey?: MessageKey
  values?: Record<string, string | number>
  code: ErrorCode
  message: string
  retryable: boolean
  /** Only ever populated in debug + non-production. Never sent otherwise. */
  detail?: string
}

export interface EngineErrorOptions {
  messageKey?: MessageKey
  values?: Record<string, string | number>
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
  readonly messageKey: MessageKey | undefined
  readonly values: Record<string, string | number> | undefined
  readonly code: ErrorCode
  readonly status: number
  readonly retryable: boolean
  readonly detail: string | undefined
  readonly headers: Record<string, string>

  constructor(code: ErrorCode, options: EngineErrorOptions = {}) {
    // A plain-JS hook can pass any string; an unknown code must degrade to the
    // closed table's catch-all, not crash the error path itself.
    const known = Object.hasOwn(ERROR_TABLE, code)
    const spec = known ? ERROR_TABLE[code] : ERROR_TABLE.internal_error
    super(options.message ?? spec.message, { cause: options.cause })
    this.messageKey =
      options.messageKey ??
      (options.message === undefined ? (known ? code : 'internal_error') : undefined)
    this.values = options.values
    this.code = known ? code : 'internal_error'
    this.status = spec.status
    this.retryable = spec.retryable
    this.detail = options.detail
    this.headers = options.headers ?? {}
  }
}

export interface MapErrorOptions {
  locale?: string
  localization?: LocaleConfig
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
 * Only our own `CheckpointError` passes its message through. Matching on the
 * status alone would let any third-party error with `status: 403` — an SDK
 * client's "your key cannot access this model" — reach the browser verbatim.
 * By name rather than `instanceof`, so this file needs no import from agent/.
 */
function checkpointStatus(error: unknown): 403 | 410 | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ((error as { name?: unknown }).name !== 'CheckpointError') return undefined
  const status = (error as { status?: unknown }).status
  return status === 403 || status === 410 ? status : undefined
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
    error instanceof EngineError
      ? error.code
      : checkpointStatus(error) !== undefined
        ? 'invalid_request'
        : isAbort(error)
          ? 'aborted'
          : 'internal_error'
  const spec = ERROR_TABLE[code]

  const mapped: MappedError = {
    code,
    message:
      error instanceof EngineError || checkpointStatus(error) !== undefined
        ? (error as Error).message
        : spec.message,
    retryable: spec.retryable,
  }

  if (options.locale !== undefined) {
    const t = createTranslator(options.localization ?? {}, options.locale)
    const messageKey =
      error instanceof EngineError
        ? error.messageKey
        : checkpointStatus(error) !== undefined
          ? (error as { messageKey?: MessageKey }).messageKey
          : code
    if (messageKey !== undefined) {
      mapped.messageKey = messageKey
      if (error instanceof EngineError && error.values !== undefined) mapped.values = error.values
      mapped.message = t(messageKey, mapped.values)
    }
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
  const status =
    error instanceof EngineError
      ? error.status
      : (checkpointStatus(error) ?? ERROR_TABLE[mapped.code].status)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
    ...(error instanceof EngineError ? error.headers : {}),
  }
  // 499 is nginx's client-closed code and is not a legal HTTP status to send.
  return new Response(JSON.stringify(mapped), {
    status: status === 499 ? 400 : status,
    headers,
  })
}
