import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { validateConfig } from '../src/index.js'
import type { ConfigError } from '../src/index.js'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const fixturesDir = resolve(packageRoot, 'test/fixtures')

/** The smallest config that validates. Every focused test builds on this. */
export function minimalConfig(): Record<string, unknown> {
  return {
    version: 1,
    name: 'Acme',
    backend: { provider: 'anthropic', model: 'claude-opus-5' },
    prompt: { system: 'You are a helpful assistant.' },
  }
}

export function readFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), 'utf8')
}

export function loadYamlFixture(name: string): unknown {
  return parseYaml(readFixture(name))
}

/**
 * Validate and return the errors, failing loudly if the config unexpectedly
 * passed — a rule test that silently validates proves nothing.
 */
export function errorsFor(
  config: unknown,
  options: Parameters<typeof validateConfig>[1] = { env: {} },
): ConfigError[] {
  const result = validateConfig(config, options)
  if (result.ok) {
    throw new Error('expected validation to fail, but it succeeded')
  }
  return result.errors
}

/** The single error produced by `rule`, or a readable failure. */
export function errorForRule(config: unknown, rule: string): ConfigError {
  const errors = errorsFor(config)
  const match = errors.find((error) => error.rule === rule)
  if (!match) {
    throw new Error(`no error with rule "${rule}"; got ${JSON.stringify(errors, null, 2)}`)
  }
  return match
}
