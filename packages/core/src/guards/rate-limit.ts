import { EngineError } from '../stream/errors.js'

/**
 * Rate limiting — docs/08-security.md §7.
 *
 * Applied **before** any model call, storage write or tool execution, which is
 * why this module has no dependency on anything downstream of it: the whole
 * point is that a limited request costs the deployment nothing but a map
 * lookup.
 *
 * The `redis` store lands in Phase 8. The interface is here now so that the
 * engine never learns which store it is talking to.
 */

export interface RateLimitRule {
  limit: number
  windowMs: number
}

const WINDOW_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Parse `"30/5m"`. The config schema has already validated the shape. */
export function parseRateLimitRule(rule: string): RateLimitRule {
  const match = /^(\d+)\/(\d+)([smhd])$/.exec(rule.trim())
  if (match === null) {
    throw new EngineError('not_ready', {
      message: `Invalid rate limit rule "${rule}".`,
      detail: 'expected <count>/<window>, e.g. 30/5m',
    })
  }
  const [, count, span, unit] = match as unknown as [string, string, string, string]
  return { limit: Number(count), windowMs: Number(span) * (WINDOW_UNITS[unit] as number) }
}

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  /** Seconds until the oldest hit in the window expires. 0 when allowed. */
  retryAfterSeconds: number
}

export interface RateLimitStore {
  /** Record one hit against `key` and report whether it was within the rule. */
  hit(key: string, rule: RateLimitRule): Promise<RateLimitResult>
  dispose?(): Promise<void>
}

export interface MemoryRateLimitStoreOptions {
  now?: () => number
  /**
   * Cap on distinct keys held. A public endpoint sees unbounded IPs, so an
   * unbounded map is a memory-exhaustion vector; the oldest keys are evicted,
   * which loses accuracy for the least recently seen callers first.
   */
  maxKeys?: number
}

/**
 * Sliding window over per-key hit timestamps.
 *
 * Single-process only. `sitebot doctor --production` fails the deployment
 * checklist when `rateLimit.store: memory` is paired with more than one
 * replica, because on N replicas this silently allows N× the configured rate —
 * a limiter that is quietly wrong is worse than one that is obviously absent.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>()
  private readonly now: () => number
  private readonly maxKeys: number

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.maxKeys = options.maxKeys ?? 100_000
  }

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const time = this.now()
    const cutoff = time - rule.windowMs

    const existing = this.hits.get(key) ?? []
    const window = existing.filter((stamp) => stamp > cutoff)

    if (window.length >= rule.limit) {
      // Re-insert so the key keeps its recency position even while blocked.
      this.hits.delete(key)
      this.hits.set(key, window)
      const oldest = window[0] as number
      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowMs - time) / 1000)),
      }
    }

    window.push(time)
    this.hits.delete(key)
    this.hits.set(key, window)
    this.evict()

    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit - window.length,
      retryAfterSeconds: 0,
    }
  }

  /** Map iteration is insertion-ordered, so the first key is the least recent. */
  private evict(): void {
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next()
      if (oldest.done === true) return
      this.hits.delete(oldest.value)
    }
  }

  async dispose(): Promise<void> {
    this.hits.clear()
  }

  /** Test/introspection helper. Not part of the `RateLimitStore` contract. */
  get size(): number {
    return this.hits.size
  }
}

/** A store that allows everything. For `sitebot dev` and tests. */
export const unlimitedRateLimitStore: RateLimitStore = {
  async hit(_key, rule) {
    return { allowed: true, limit: rule.limit, remaining: rule.limit, retryAfterSeconds: 0 }
  },
}

export interface RateLimitCheckInput {
  store: RateLimitStore
  sessionId: string
  ip: string | null
  perSession: string
  perIp: string
}

/**
 * Check both rules, session first.
 *
 * Session before IP is deliberate: the session rule is the one a legitimate
 * over-eager user trips, and reporting *that* limit's `Retry-After` gives them
 * an accurate wait. The IP rule exists for the case where sessionIds are being
 * rotated to evade the first rule, and is skipped when the IP is unknown rather
 * than lumping every unknown-IP caller into one shared bucket.
 */
export async function checkRateLimit(input: RateLimitCheckInput): Promise<void> {
  const checks: [string, string][] = [[`session:${input.sessionId}`, input.perSession]]
  if (input.ip !== null && input.ip !== '') checks.push([`ip:${input.ip}`, input.perIp])

  for (const [key, rule] of checks) {
    const result = await input.store.hit(key, parseRateLimitRule(rule))
    if (!result.allowed) {
      throw new EngineError('rate_limited', {
        detail: `${key} exceeded ${rule}`,
        headers: { 'retry-after': String(result.retryAfterSeconds) },
      })
    }
  }
}
