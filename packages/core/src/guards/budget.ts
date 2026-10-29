import type { Budget, ConfigError, ResolvedConfig } from '@sitebot/config'
import defaultPricing from '../../pricing.json'
import { EngineError } from '../stream/errors.js'
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

/** Pricing lives in core; schema validation in the config layer stays model-agnostic. */
export function validateBudgetPricing(
  config: Pick<ResolvedConfig, 'backend' | 'security'>,
): ConfigError[] {
  if (config.security.budget.maxUsdPerDay === undefined) return []
  const pricing = { ...(defaultPricing as PricingTable), ...config.backend.pricing }
  const entries = [
    { entry: config.backend, path: 'backend' },
    ...config.backend.fallback.map((entry, index) => ({
      entry,
      path: `backend.fallback[${index}]`,
    })),
    // Also used for history summaries, even when onExceeded is not "degrade".
    ...(config.security.budget.degradeTo === undefined
      ? []
      : [{ entry: config.security.budget.degradeTo, path: 'security.budget.degradeTo' }]),
  ]
  return entries.flatMap(({ entry, path }) => {
    const modelId = `${entry.provider}:${entry.model}`
    return modelPrice(pricing, modelId) !== undefined
      ? []
      : [
          {
            path: `${path}.model`,
            value: entry.model,
            message: `USD budget requires pricing for "${modelId}".`,
            fix: `Set backend.pricing["${modelId}"] with inputUsdPerMillion and outputUsdPerMillion, or remove maxUsdPerDay to use token-only budgets.`,
            rule: 'budget/missing-pricing',
          },
        ]
  })
}

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
      // Guards and the engine can check the same tracker at different times.
      // Refresh completed spend from other instances before each admission.
      await load(true)
      // Missing prices (including a missing model ID) cannot authorize spend.
      // Do not degrade here: that could select another unpriced model.
      if (
        options.budget?.maxUsdPerDay !== undefined &&
        (modelId === undefined || modelPrice(pricing, modelId) === undefined)
      ) {
        return 'block'
      }
      const estimatedUsd =
        modelId === undefined
          ? 0
          : usageCost(
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
      const degradeTo = budget?.degradeTo
      return budget?.onExceeded === 'degrade' &&
        degradeTo !== undefined &&
        (budget.maxUsdPerDay === undefined ||
          modelPrice(pricing, `${degradeTo.provider}:${degradeTo.model}`) !== undefined)
        ? 'degrade'
        : 'block'
    },

    async record(usage, modelId) {
      if (
        options.budget?.maxUsdPerDay !== undefined &&
        modelPrice(pricing, modelId) === undefined
      ) {
        throw new EngineError('not_ready', {
          detail: `USD budget requires pricing for "${modelId}"; configure backend.pricing before recording usage.`,
        })
      }
      await load()
      const delta = {
        tokens: usage.totalTokens,
        usd: usageCost(usage, modelId, pricing, options.logger),
      }
      tracker.session = await add(sessionKey, delta, 30 * 24 * 60 * 60 * 1000)
      tracker.day = await add(dayKey, delta, day.ttlMs)
    },
  }

  async function load(refresh = false): Promise<void> {
    if (loaded && (!refresh || options.store?.getUsage === undefined)) return
    const [session, dayUsage] = await Promise.all([get(sessionKey), get(dayKey)])
    tracker.session = session
    tracker.day = dayUsage
    // A failed read must remain retryable and must never authorize from zeros.
    loaded = true
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

export function usageCost(
  usage: TokenUsage,
  modelId: string,
  pricing: PricingTable,
  logger?: Logger,
): number {
  const price = modelPrice(pricing, modelId)
  if (price === undefined) {
    if (!warnedModels.has(modelId)) {
      warnedModels.add(modelId)
      logger?.warn('no pricing entry for model; USD usage is unavailable (token-only accounting)', {
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

function modelPrice(pricing: PricingTable, modelId: string): ModelPrice | undefined {
  const price = Object.hasOwn(pricing, modelId) ? pricing[modelId] : undefined
  return price !== undefined &&
    Number.isFinite(price.inputUsdPerMillion) &&
    price.inputUsdPerMillion >= 0 &&
    Number.isFinite(price.outputUsdPerMillion) &&
    price.outputUsdPerMillion >= 0
    ? price
    : undefined
}

function dayBucket(time: number, resetHourUtc: number): { id: string; ttlMs: number } {
  const shifted = time - resetHourUtc * 60 * 60 * 1000
  const date = new Date(shifted)
  const id = date.toISOString().slice(0, 10)
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  return { id, ttlMs: Math.max(1, next - shifted) }
}
