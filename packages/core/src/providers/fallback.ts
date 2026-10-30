import type { BackendEntry } from '@sitebot/config'
import { EngineError } from '../stream/errors.js'

/**
 * The fallback chain — docs/04-providers-and-engine.md §3.
 *
 * The one rule that shapes this whole module: **hopping is only attempted
 * before the first token is emitted.** Once output has reached the user,
 * switching models mid-answer produces incoherent text, so a mid-stream failure
 * becomes a retryable `data-error` part instead (§3 rule 5). That is why
 * `runChain` wraps only the act of *starting* a stream, and never the stream
 * itself.
 */

/** Statuses worth retrying within the same provider — §3 rule 2. */
export const RETRYABLE_STATUSES: readonly number[] = [429, 500, 502, 503, 504]

/** Statuses that will never succeed on retry — §3 rule 3. */
export const FATAL_STATUSES: readonly number[] = [400, 401, 403, 404]

const RETRYABLE_NETWORK_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]

/**
 * Errors that must not be retried even though their status might say otherwise:
 * a prompt that is too long stays too long, and a content filter will refuse
 * again. Matched on message text because providers do not agree on a code.
 */
const FATAL_MESSAGE_PATTERNS = [
  /context[_ -]?length[_ -]?exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /content[_ -]?filter/i,
  /content policy/i,
  /invalid[_ -]?api[_ -]?key/i,
]

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as { statusCode?: unknown; status?: unknown; response?: unknown }
  for (const value of [
    candidate.statusCode,
    candidate.status,
    (candidate.response as { status?: unknown } | undefined)?.status,
  ]) {
    if (typeof value === 'number') return value
  }
  return undefined
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

function failureCategory(error: unknown): string {
  const status = statusOf(error)
  return `${classifyError(error)}${status === undefined ? '' : ` (HTTP ${status})`}`
}

export type Classification = 'retryable' | 'fatal'

/**
 * Decide whether an error is worth another attempt against the same provider.
 *
 * Unknown errors are classified `fatal`. Retrying something we do not
 * understand spends the user's latency and the developer's money on a coin
 * flip; hopping to the next provider — which a `fatal` classification still
 * does — is both faster and more likely to work.
 */
export function classifyError(error: unknown): Classification {
  const message = messageOf(error)
  if (FATAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) return 'fatal'

  const status = statusOf(error)
  if (status !== undefined) {
    if (FATAL_STATUSES.includes(status)) return 'fatal'
    if (RETRYABLE_STATUSES.includes(status)) return 'retryable'
    return status >= 500 ? 'retryable' : 'fatal'
  }

  const code = codeOf(error)
  if (code !== undefined && RETRYABLE_NETWORK_CODES.includes(code)) return 'retryable'
  if (/timed? ?out|socket hang up|network error|fetch failed/i.test(message)) return 'retryable'

  return 'fatal'
}

export interface BackoffOptions {
  baseMs?: number
  factor?: number
  jitter?: number
  /** Injected in tests; defaults to `Math.random`. */
  random?: () => number
}

/**
 * Exponential backoff with jitter — 250 ms base, ×2, ±20% (§3 rule 1).
 * `attempt` is 0-based: the delay *before* retry number `attempt + 1`.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 250
  const factor = options.factor ?? 2
  const jitter = options.jitter ?? 0.2
  const random = options.random ?? Math.random
  const raw = base * factor ** attempt
  // random() ∈ [0,1) → spread ∈ [-jitter, +jitter)
  const spread = (random() * 2 - 1) * jitter
  return Math.max(0, Math.round(raw * (1 + spread)))
}

export interface FallbackEvent {
  from: string
  to: string
  reason: string
  attempts: number
}

export interface RunChainOptions<T> {
  entries: readonly BackendEntry[]
  /** Start the operation against one entry. Must reject to trigger the chain. */
  attempt: (entry: BackendEntry, index: number) => Promise<T>
  /** Emitted on every hop — silent degradation is a bug (§3 rule 6). */
  onFallback?: (event: FallbackEvent) => void
  sleep?: (ms: number) => Promise<void>
  backoff?: BackoffOptions
}

export interface ChainResult<T> {
  value: T
  entry: BackendEntry
  index: number
  /** Total attempts made across the whole chain, successful one included. */
  attempts: number
}

const entryId = (entry: BackendEntry): string => `${entry.provider}:${entry.model}`

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Try each entry in order, retrying within an entry while the error is
 * retryable, then hopping. Throws `provider_error` if the whole chain fails
 * (§3 rule 7) — the original errors are attached as `cause` for the logs and
 * never reach the browser.
 */
export async function runChain<T>(options: RunChainOptions<T>): Promise<ChainResult<T>> {
  const { entries, attempt } = options
  const sleep = options.sleep ?? defaultSleep

  if (entries.length === 0) {
    throw new EngineError('not_ready', { message: 'No model is configured.' })
  }

  const failures: { id: string; error: unknown }[] = []
  let attempts = 0

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as BackendEntry
    const maxAttempts = entry.maxRetries + 1
    let attemptsHere = 0
    let lastError: unknown

    while (attemptsHere < maxAttempts) {
      attempts += 1
      attemptsHere += 1
      try {
        return { value: await attempt(entry, index), entry, index, attempts }
      } catch (error) {
        lastError = error
        // A cancelled request is not a provider failure; do not burn the chain.
        if (error instanceof Error && error.name === 'AbortError') throw error
        if (classifyError(error) === 'fatal') break
        if (attemptsHere >= maxAttempts) break
        await sleep(backoffDelay(attemptsHere - 1, options.backoff))
      }
    }

    failures.push({ id: entryId(entry), error: lastError })

    const next = entries[index + 1]
    if (next !== undefined) {
      options.onFallback?.({
        from: entryId(entry),
        to: entryId(next),
        reason: failureCategory(lastError),
        attempts: attemptsHere,
      })
    }
  }

  throw new EngineError('provider_error', {
    detail: failures
      .map((failure) => `${failure.id}: ${failureCategory(failure.error)}`)
      .join('; '),
    cause: failures[failures.length - 1]?.error,
  })
}
