import type { LogLevel, Logger } from '../types.js'

/**
 * Structured logging with a redaction pass — docs/08-security.md §2:
 * "keys never appear in logs".
 *
 * The redactor runs over every field of every record rather than at the call
 * sites, because the one call site that forgets is the one that leaks.
 */

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

export const REDACTED = '[redacted]'

/**
 * Known API-key shapes. Deliberately broad on the prefix and loose on the tail:
 * a false positive costs a developer one unreadable log line, a false negative
 * costs them a rotated key.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // openai, anthropic legacy
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g, // google
  /\bgsk_[A-Za-z0-9]{20,}/g, // groq
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // jwt
]

/** Field names whose value is dropped wholesale, whatever it looks like. */
export const SECRET_FIELDS: readonly string[] = [
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'secret',
  'token',
  'password',
  'cookie',
  'set-cookie',
]

/** Fields carrying user or model text, dropped when `redactPrompts` is on. */
export const PROMPT_FIELDS: readonly string[] = [
  'prompt',
  'system',
  'messages',
  'message',
  'text',
  'input',
  'output',
  'content',
  'extract',
]

export interface LoggerOptions {
  level?: LogLevel
  /** docs/02 §13 `telemetry.redactPromptsInLogs`. Default true. */
  redactPrompts?: boolean
  /** Where records go. Injected so tests do not need to patch the console. */
  sink?: (record: LogRecord) => void
  /** Fields stamped onto every record. */
  base?: Record<string, unknown>
}

export interface LogRecord {
  level: Exclude<LogLevel, 'silent'>
  message: string
  time: number
  fields: Record<string, unknown>
}

/** Replace every known secret shape inside a string. */
export function redactString(value: string): string {
  let out = value
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), REDACTED)
  }
  return out
}

/**
 * Redact a log payload. Recurses through objects and arrays; cycles are
 * replaced with `[circular]` rather than throwing, since a logger that can
 * crash the request is worse than a log line that is missing detail.
 */
export function redact(
  value: unknown,
  options: { redactPrompts?: boolean } = {},
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => redact(item, options, seen))
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) }
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (SECRET_FIELDS.includes(lower)) {
      out[key] = REDACTED
      continue
    }
    if (options.redactPrompts !== false && PROMPT_FIELDS.includes(lower)) {
      out[key] = REDACTED
      continue
    }
    out[key] = redact(item, options, seen)
  }
  return out
}

const defaultSink = (record: LogRecord): void => {
  const line = JSON.stringify({
    level: record.level,
    time: new Date(record.time).toISOString(),
    msg: record.message,
    ...record.fields,
  })
  if (record.level === 'error') console.error(line)
  else console.warn(line)
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const redactPrompts = options.redactPrompts ?? true
  const sink = options.sink ?? defaultSink
  const base = options.base ?? {}

  const emit = (
    recordLevel: Exclude<LogLevel, 'silent'>,
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVEL_ORDER[recordLevel] > LEVEL_ORDER[level]) return
    const merged = { ...base, ...(fields ?? {}) }
    sink({
      level: recordLevel,
      message: redactString(message),
      time: Date.now(),
      fields: redact(merged, { redactPrompts }) as Record<string, unknown>,
    })
  }

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  }
}

/** A logger that swallows everything. Handy in tests and in `logLevel: silent`. */
export const silentLogger: Logger = createLogger({ level: 'silent', sink: () => {} })
