import { describe, expect, it, vi } from 'vitest'
import { ConfigValidationError } from '@sitebot/config'
import { testConfig } from '../../test/helpers.js'
import { createEngine } from '../engine.js'
import { createBudgetTracker, validateBudgetPricing } from './budget.js'
import { MemoryRateLimitStore } from './rate-limit.js'

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }
const dollarBudget = { maxUsdPerDay: 0.01, onExceeded: 'message' as const, resetHourUtc: 0 }

describe('shared budget reads', () => {
  it('observes completed spend from another tracker before a second admission check', async () => {
    const store = new MemoryRateLimitStore()
    const options = {
      budget: { maxTokensPerDay: 10, onExceeded: 'error' as const, resetHourUtc: 0 },
      store,
    }
    const reader = createBudgetTracker(options)
    expect(await reader.check(1)).toBe('ok')
    await createBudgetTracker(options).record(
      { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      'fixture:model',
    )
    expect(await reader.check(1)).toBe('block')
  })

  it('does not latch a failed shared read and then authorize from zero usage', async () => {
    const store = new MemoryRateLimitStore()
    const options = {
      budget: { maxTokensPerDay: 10, onExceeded: 'error' as const, resetHourUtc: 0 },
      store,
    }
    await createBudgetTracker(options).record(
      { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      'fixture:model',
    )
    vi.spyOn(store, 'getUsage').mockRejectedValueOnce(new Error('synthetic store outage'))
    const tracker = createBudgetTracker(options)
    await expect(tracker.check(1)).rejects.toThrow('synthetic store outage')
    expect(await tracker.check(1)).toBe('block')
  })
})

describe('USD budget pricing', () => {
  it('blocks an unpriced model and refuses to record it as free', async () => {
    const store = new MemoryRateLimitStore()
    const tracker = createBudgetTracker({ budget: dollarBudget, store })
    await expect(tracker.check(100, 'openai:gpt-5-mini')).resolves.toBe('block')
    await expect(tracker.record(usage, 'openai:gpt-5-mini')).rejects.toMatchObject({
      code: 'not_ready',
    })
    expect(tracker.day).toEqual({ tokens: 0, usd: 0 })
    // Refusing invalid accounting must not mutate the shared store either.
    const reloaded = createBudgetTracker({ budget: dollarBudget, store })
    await expect(reloaded.check(1, 'openai:gpt-4o-mini')).resolves.toBe('ok')
    expect(reloaded.day).toEqual({ tokens: 0, usd: 0 })
  })

  it('requires a model ID for USD checks, including zero-token estimates', async () => {
    const tracker = createBudgetTracker({ budget: dollarBudget })
    await expect(tracker.check(0)).resolves.toBe('block')
    await expect(tracker.check(0, 'unknown:model')).resolves.toBe('block')
  })

  it('does not authorize degradation when the checked model is unpriced', async () => {
    const config = testConfig({
      security: {
        budget: {
          ...dollarBudget,
          onExceeded: 'degrade',
          degradeTo: { provider: 'openai', model: 'also-unpriced' },
        },
      },
    })
    const tracker = createBudgetTracker({ budget: config.security.budget })
    await expect(tracker.check(100, 'openai:gpt-5-mini')).resolves.toBe('block')
  })

  it.each([
    ['unpriced-degradation', 'block'],
    ['gpt-4o-mini', 'degrade'],
  ] as const)(
    'checks the degradation model price after a priced model exceeds its cap (%s)',
    async (model, decision) => {
      const config = testConfig({
        security: {
          budget: {
            ...dollarBudget,
            onExceeded: 'degrade',
            degradeTo: { provider: 'openai', model },
          },
        },
      })
      const tracker = createBudgetTracker({ budget: config.security.budget })
      await tracker.record(usage, 'openai:gpt-4o')
      await expect(tracker.check(100, 'openai:gpt-4o')).resolves.toBe(decision)
    },
  )

  it('keeps token-only accounting and shared token enforcement for unpriced models', async () => {
    const store = new MemoryRateLimitStore()
    const budget = { maxTokensPerDay: 2_000_000, onExceeded: 'message' as const, resetHourUtc: 0 }
    const tracker = createBudgetTracker({ budget, store })
    await tracker.record(usage, 'openai:gpt-5-mini')
    expect(tracker.day).toEqual({ tokens: 2_000_000, usd: 0 })
    const next = createBudgetTracker({ budget, store })
    await expect(next.check(1, 'openai:gpt-5-mini')).resolves.toBe('block')
  })

  it('charges shipped prices and blocks once the dollar cap is exceeded', async () => {
    const tracker = createBudgetTracker({ budget: dollarBudget })
    await tracker.record(usage, 'openai:gpt-4o-mini')
    expect(tracker.day.usd).toBeCloseTo(0.75)
    await expect(tracker.check(100, 'openai:gpt-4o-mini')).resolves.toBe('block')
  })

  it.each(['openai:gpt-5-mini', 'openai:gpt-4o-mini'])(
    'uses explicit prices over missing or shipped prices for %s',
    async (modelId) => {
      // Synthetic rates for offline tests, not provider price recommendations.
      const tracker = createBudgetTracker({
        budget: { ...dollarBudget, maxUsdPerDay: 2 },
        pricing: { [modelId]: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      })
      await expect(tracker.check(1_000_000, modelId)).resolves.toBe('ok')
      await tracker.record(usage, modelId)
      expect(tracker.day.usd).toBe(3)
      await expect(tracker.check(1, modelId)).resolves.toBe('block')
    },
  )

  it('accepts explicit zero prices for a free local model', async () => {
    const tracker = createBudgetTracker({
      budget: dollarBudget,
      pricing: { 'ollama:local': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    })
    await tracker.record(usage, 'ollama:local')
    await expect(tracker.check(100, 'ollama:local')).resolves.toBe('ok')
    expect(tracker.day).toEqual({ tokens: 2_000_000, usd: 0 })
  })
})

describe('configured model pricing validation', () => {
  const configWithModels = () =>
    testConfig({
      backend: {
        provider: 'openai',
        model: 'gpt-5-mini',
        fallback: [{ provider: 'anthropic', model: 'unpriced-fallback' }],
      },
      security: {
        budget: {
          ...dollarBudget,
          // Used for summaries even when onExceeded is "message".
          degradeTo: { provider: 'openai', model: 'unpriced-summary' },
        },
      },
    })

  it('identifies primary, fallback and summary/degradation models with actionable paths', () => {
    const errors = validateBudgetPricing(configWithModels())
    expect(errors.map((error) => error.path)).toEqual([
      'backend.model',
      'backend.fallback[0].model',
      'security.budget.degradeTo.model',
    ])
    expect(errors.every((error) => error.fix?.includes('backend.pricing'))).toBe(true)
  })

  it('rejects missing pricing when creating an engine, before acquiring resources', () => {
    expect(() => createEngine(configWithModels())).toThrow(ConfigValidationError)
  })

  it('accepts overrides for all selected models and explicit zero prices', async () => {
    const config = configWithModels()
    for (const model of [
      'openai:gpt-5-mini',
      'anthropic:unpriced-fallback',
      'openai:unpriced-summary',
    ]) {
      config.backend.pricing[model] = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
    }
    expect(validateBudgetPricing(config)).toEqual([])
    const engine = createEngine(config)
    await engine.dispose()
  })

  it('accepts new model IDs without pricing when only token limits are enabled', async () => {
    const config = configWithModels()
    delete config.security.budget.maxUsdPerDay
    config.security.budget.maxTokensPerDay = 1000
    expect(validateBudgetPricing(config)).toEqual([])
    const engine = createEngine(config)
    await engine.dispose()
  })
})
