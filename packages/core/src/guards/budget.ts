import type { Budget } from '@sitebot/config'
import type { BudgetTracker, TokenUsage } from '../types.js'

/**
 * Budgets — docs/04-providers-and-engine.md §8, docs/08-security.md §8.
 *
 * Enforcement (pricing table, daily counters in the rate-limit store,
 * `degrade`/`message`/`error`) is Phase 8. What exists now is a tracker that
 * accumulates real usage in memory and always answers `ok`, so that
 * `RequestContext.budget` is a live object from the first phase that has one
 * and tool executors written in Phase 5 do not have to guess at the shape.
 */

export interface BudgetTrackerOptions {
  budget?: Budget
  /** Called when a limit would have been hit. Phase 8 replaces this wholesale. */
  onWouldExceed?: (which: 'session' | 'day') => void
}

export function createBudgetTracker(options: BudgetTrackerOptions = {}): BudgetTracker {
  const zero = () => ({ tokens: 0, usd: 0 })
  const calls = new Map<string, number>()
  const tracker: BudgetTracker = {
    session: zero(),
    day: zero(),

    async toolCalls(name = '*') {
      const count = (calls.get(name) ?? 0) + 1
      calls.set(name, count)
      return count - 1
    },

    check(estimateTokens: number) {
      const limit = options.budget?.maxTokensPerSession
      if (limit !== undefined && tracker.session.tokens + estimateTokens > limit) {
        options.onWouldExceed?.('session')
      }
      // Always `ok` until Phase 8: reporting `block` without the daily counters
      // and the reset boundary behind it would enforce a limit inconsistently
      // across replicas, which is worse than not enforcing it yet.
      return 'ok'
    },

    async record(usage: TokenUsage) {
      tracker.session.tokens += usage.totalTokens
      tracker.day.tokens += usage.totalTokens
    },
  }

  return tracker
}
