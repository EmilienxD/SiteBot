import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateConfig } from '@sitebot/config'
import { diagnose, runDoctor } from './commands/doctor.js'
import { runValidate } from './commands/validate.js'
import { productionDoctor } from './index.js'
import { Ui } from './terminal.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function input() {
  return {
    version: 1,
    name: 'Pricing test',
    backend: {
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'unused',
      fallback: [{ provider: 'openai', model: 'offline-fallback' }],
      pricing: {} as Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>,
    },
    prompt: { system: 'Help visitors.' },
    security: {
      budget: {
        maxUsdPerDay: 1 as number | undefined,
        degradeTo: { provider: 'openai', model: 'offline-summary' },
      },
    },
  }
}

async function context(raw = input(), flags = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'sitebot-budget-pricing-'))
  directories.push(cwd)
  await writeFile(join(cwd, 'chatbot.config.json'), JSON.stringify(raw))
  const output: string[] = []
  return {
    cwd,
    flags,
    env: {},
    positionals: [],
    ui: new Ui({
      color: false,
      write: (text) => output.push(text),
      writeError: (text) => output.push(text),
    }),
    text: () => output.join(''),
  }
}

describe('pricing validation and diagnostics', () => {
  it.each([{}, { json: true }, { quiet: true }])(
    'fails sitebot validate for a USD cap with missing prices (%j)',
    async (flags) => {
      const ctx = await context(input(), flags)
      expect((await runValidate(ctx)).exitCode).toBe(1)
      expect(ctx.text()).toContain('openai:gpt-5-mini')
      expect(ctx.text()).toContain('backend.fallback[0].model')
      expect(ctx.text()).toContain('security.budget.degradeTo.model')
      expect(ctx.text()).toContain('backend.pricing')
    },
  )

  it('accepts explicit overrides for every model in validate and doctor', async () => {
    const raw = input()
    for (const model of ['gpt-5-mini', 'offline-fallback', 'offline-summary']) {
      raw.backend.pricing[`openai:${model}`] = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
    }
    const ctx = await context(raw)
    expect((await runValidate(ctx)).exitCode).toBe(0)
    const resolved = validateConfig(raw)
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors))
    const report = await diagnose(resolved.value, { cwd: ctx.cwd, env: {}, offline: true })
    expect(report.checks.find((check) => check.name === 'budget pricing')?.status).toBe('pass')
  })

  it('keeps token-only configurations valid for arbitrary models', async () => {
    const raw = input()
    raw.security.budget.maxUsdPerDay = undefined
    const ctx = await context(raw)
    expect((await runValidate(ctx)).exitCode).toBe(0)
    const resolved = validateConfig(raw)
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors))
    const report = await diagnose(resolved.value, { cwd: ctx.cwd, env: {}, offline: true })
    expect(report.checks.find((check) => check.name === 'budget pricing')?.status).toBe('skip')
  })

  it.each([true, false])(
    'reports all missing model prices through doctor (offline: %s)',
    async (offline) => {
      const resolved = validateConfig(input())
      if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors))
      const report = await diagnose(resolved.value, { cwd: process.cwd(), env: {}, offline })
      expect(report.ok).toBe(false)
      const pricing = report.checks.filter((check) => check.name.startsWith('budget pricing'))
      expect(pricing).toHaveLength(3)
      expect(
        pricing.every((check) => check.status === 'fail' && check.fix?.includes('backend.pricing')),
      ).toBe(true)
      const production = productionDoctor(resolved.value)
      expect(production.checks.find((check) => check.label === 'budget pricing')?.ok).toBe(false)
    },
  )

  it.each([{ offline: true }, { offline: true, json: true }, { production: true, json: true }])(
    'returns failure from the doctor command for missing pricing (%j)',
    async (flags) => {
      const ctx = await context(input(), flags)
      expect((await runDoctor(ctx)).exitCode).toBe(1)
      expect(ctx.text()).toContain('openai:gpt-5-mini')
      expect(ctx.text()).toContain('backend.pricing')
    },
  )
})
