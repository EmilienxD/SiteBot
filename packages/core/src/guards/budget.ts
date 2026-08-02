import type { Budget } from '@sitebot/config'
import defaultPricing from '../../pricing.json'
import type { BudgetTracker, Logger, TokenUsage } from '../types.js'
import type { RateLimitStore } from './rate-limit.js'

export interface ModelPrice {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
}

export type PricingTable = Record<string, ModelPrice>

export interface BudgetTrackerOptions {
  budget?: Budget
  sessionId?: string
  store?: RateLimitStore
  pricing?: PricingTable
  logger?: Logger
  now?: () => number
}

const warnedModels = new Set<string>()

export function createBudgetTracker(options: BudgetTrackerOptions = {}): BudgetTracker {
  const zero = () => ({ tokens: 0, usd: 0 })
  const calls = new Map<string, number>()
  const now = options.now ?? (() => Date.now())
  const pricing = { ...(defaultPricing as PricingTable), ...options.pricing }
  const sessionKey = `budget:session:${options.sessionId ?? 'anonymous'}`
  const day = dayBucket(now(), options.budget?.resetHourUtc ?? 0)
  const dayKey = `budget:day:${day.id}`
  let loaded = false

  const tracker: BudgetTracker = {
    session: zero(),
    day: zero(),

    async toolCalls(name = '*') {
      const count = (calls.get(name) ?? 0) + 1
      calls.set(name, count)
      return count - 1
    },

    async check(estimateTokens, modelId) {
      await load()
      const estimatedUsd =
        modelId === undefined
          ? 0
          : costOf(
              { inputTokens: estimateTokens, outputTokens: 0, totalTokens: estimateTokens },
              modelId,
              pricing,
              options.logger,
            )
      const budget = options.budget
      const exceeded =
        (budget?.maxTokensPerSession !== undefined &&
          tracker.session.tokens + estimateTokens > budget.maxTokensPerSession) ||
        (budget?.maxTokensPerDay !== undefined &&
          tracker.day.tokens + estimateTokens > budget.maxTokensPerDay) ||
        (budget?.maxUsdPerDay !== undefined && tracker.day.usd + estimatedUsd > budget.maxUsdPerDay)

      if (!exceeded) return 'ok'
      return budget?.onExceeded === 'degrade' && budget.degradeTo !== undefined
        ? 'degrade'
        : 'block'
    },

    async record(usage, modelId) {
      await load()
      const delta = {
        tokens: usage.totalTokens,
        usd: costOf(usage, modelId, pricing, options.logger),
      }
      tracker.session = await add(sessionKey, delta, 30 * 24 * 60 * 60 * 1000)
      tracker.day = await add(dayKey, delta, day.ttlMs)
    },
  }

  async function load(): Promise<void> {
    if (loaded) return
    loaded = true
    tracker.session = await get(sessionKey)
    tracker.day = await get(dayKey)
  }

  async function get(key: string): Promise<{ tokens: number; usd: number }> {
    return options.store?.getUsage?.(key) ?? zero()
  }

  async function add(
    key: string,
    delta: { tokens: number; usd: number },
    ttlMs: number,
  ): Promise<{ tokens: number; usd: number }> {
    if (options.store?.addUsage !== undefined) return options.store.addUsage(key, delta, ttlMs)
    const current = key === sessionKey ? tracker.session : tracker.day
    return { tokens: current.tokens + delta.tokens, usd: current.usd + delta.usd }
  }

  return tracker
}

function costOf(
  usage: TokenUsage,
  modelId: string,
  pricing: PricingTable,
  logger?: Logger,
): number {
  const price = pricing[modelId]
  if (price === undefined) {
    if (!warnedModels.has(modelId)) {
      warnedModels.add(modelId)
      logger?.warn('no pricing entry for model; USD budgets are token-only for it', {
        model: modelId,
      })
    }
    return 0
  }
  return (
    (usage.inputTokens * price.inputUsdPerMillion +
      usage.outputTokens * price.outputUsdPerMillion) /
    1_000_000
  )
}

function dayBucket(time: number, resetHourUtc: number): { id: string; ttlMs: number } {
  const shifted = time - resetHourUtc * 60 * 60 * 1000
  const date = new Date(shifted)
  const id = date.toISOString().slice(0, 10)
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  return { id, ttlMs: Math.max(1, next - shifted) }
}
