import type { z } from 'zod'
import { checkCrossFields } from './cross-field.js'
import { interpolateEnv } from './env.js'
import { didYouMean, formatPath } from './errors.js'
import { RuntimeConfigSchema } from './schema/config.js'
import { keysAtPath } from './schema/keys.js'
import type { SiteBotConfig } from './schema/config.js'
import type { BuildTarget, ConfigError, ResolutionMeta, Result } from './types.js'

/** A validated config plus the metadata `toPublicConfig` needs. */
export type ResolvedConfig = SiteBotConfig & { $meta: ResolutionMeta }

export interface ValidateOptions {
  /** Where this config will run. Drives the edge-only rules. Default `node`. */
  target?: BuildTarget
  /**
   * Environment used to resolve `${env.*}`. Defaults to `process.env` where it
   * exists, `{}` otherwise — reading it off `globalThis` keeps this module free
   * of any Node import so it still bundles for the browser.
   */
  env?: Readonly<Record<string, string | undefined>>
  sourcePath?: string | null
  baseDir?: string | null
  extendsChain?: readonly string[]
}

function ambientEnv(): Readonly<Record<string, string | undefined>> {
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return process?.env ?? {}
}

/**
 * Parse, resolve and check a raw config object.
 *
 * Never throws for invalid input — a caller that wants an exception should use
 * `loadConfig`, which wraps the errors in a `ConfigValidationError`.
 */
export function validateConfig(
  raw: unknown,
  options: ValidateOptions = {},
): Result<ResolvedConfig, ConfigError[]> {
  const target = options.target ?? 'node'

  const interpolated = interpolateEnv(raw, {
    env: options.env ?? ambientEnv(),
  })
  const envPaths = [...interpolated.envPaths]

  const parsed = RuntimeConfigSchema.safeParse(interpolated.value)
  if (!parsed.success) {
    return {
      ok: false,
      errors: [...interpolated.errors, ...toConfigErrors(parsed.error, interpolated.value)],
    }
  }

  // A missing environment variable leaves a placeholder in place, which may
  // well have satisfied the schema. Report it now rather than booting with a
  // literal "${env.ANTHROPIC_API_KEY}" as the API key.
  if (interpolated.errors.length > 0) {
    return { ok: false, errors: interpolated.errors }
  }

  const config = applyDerivedDefaults(parsed.data, envPaths)
  const { errors, warnings } = checkCrossFields(config, { target, envPaths })
  if (errors.length > 0) return { ok: false, errors }

  const meta: ResolutionMeta = {
    sourcePath: options.sourcePath ?? null,
    baseDir: options.baseDir ?? null,
    extendsChain: options.extendsChain ?? [],
    envPaths,
    target,
  }

  return { ok: true, value: { ...config, $meta: meta }, warnings }
}

/**
 * Defaults that read a sibling field, which Zod cannot express.
 *
 * Resolving them here rather than in the engine is what lets `sitebot validate`
 * print the config with every default made explicit and have that be the truth
 * (docs/02-configuration.md §14).
 */
function applyDerivedDefaults(config: SiteBotConfig, envPaths: string[]): SiteBotConfig {
  const next: SiteBotConfig = { ...config }

  // docs/02 §9: retrieval mode follows `mode` unless set explicitly.
  if (next.knowledge.retrieval.mode === undefined) {
    next.knowledge = {
      ...next.knowledge,
      retrieval: {
        ...next.knowledge.retrieval,
        mode: next.mode === 'chat' ? 'always' : 'tool',
      },
    }
  }

  // docs/02 §11: the panel title falls back to the top-level name. If the name
  // came from the environment the derived title did too, so it has to inherit
  // the marking — otherwise a secret would launder itself into the public
  // config through a field nobody thought of as env-sourced.
  if (next.ui.panel.title === undefined) {
    next.ui = {
      ...next.ui,
      panel: { ...next.ui.panel, title: next.name },
    }
    if (envPaths.includes('name')) envPaths.push('ui.panel.title')
  }

  return next
}

// ── Zod issues → ConfigError ────────────────────────────────────────────────

function toConfigErrors(error: z.ZodError, input: unknown): ConfigError[] {
  return error.issues.flatMap((issue) => fromIssue(issue, input, []))
}

/**
 * Zod 4 does not carry the rejected value on an issue, only its path — so the
 * "offending value" half of docs/02 §14's contract is recovered by walking the
 * input we handed it.
 */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

/** Attach `value` only when there is one; `value: undefined` is just noise. */
function withValue(error: ConfigError, value: unknown): ConfigError {
  return value === undefined ? error : { ...error, value }
}

function fromIssue(issue: z.core.$ZodIssue, input: unknown, prefix: PropertyKey[]): ConfigError[] {
  const path = [...prefix, ...issue.path]
  const formatted = formatPath(path)
  const value = valueAt(input, path)

  switch (issue.code) {
    case 'unrecognized_keys':
      return issue.keys.map((key) => {
        const candidates = keysAtPath(RuntimeConfigSchema, path)
        const suggestion = didYouMean(key, candidates)
        return {
          path: formatted === '' ? key : `${formatted}.${key}`,
          message: `Unknown key "${key}".`,
          expected:
            candidates.length > 0 ? `one of: ${candidates.slice().sort().join(', ')}` : undefined,
          suggestion,
          fix: suggestion
            ? `Did you mean "${suggestion}"? Unknown keys are errors, not warnings, so a typo can never be silently ignored.`
            : 'Remove it, or check docs/02-configuration.md for the key you meant.',
          rule: 'schema/unknown-key',
        }
      })

    case 'invalid_union': {
      // Report the branch that got furthest rather than every branch's
      // complaints, which for a five-way executor union is unreadable.
      const branches = issue.errors
      if (branches.length === 0) break
      let best = branches[0] as z.core.$ZodIssue[]
      for (const branch of branches) {
        if (branch.length < best.length) best = branch as z.core.$ZodIssue[]
      }
      return best.flatMap((inner) => fromIssue(inner, input, path))
    }

    case 'invalid_value': {
      const values = issue.values.map((option) => String(option))
      return [
        withValue(
          {
            path: formatted,
            message: `${describeValue(value)} is not valid here.`,
            expected: values.join(' | '),
            suggestion: typeof value === 'string' ? didYouMean(value, values) : undefined,
            fix: `Use one of: ${values.join(', ')}.`,
            rule: 'schema/invalid-value',
          },
          value,
        ),
      ]
    }

    case 'invalid_type':
      return [
        withValue(
          {
            path: formatted,
            message: `Expected ${issue.expected}, received ${describeType(value)}.`,
            expected: issue.expected,
            fix:
              value === undefined
                ? 'This field is required.'
                : `Change the value to a ${issue.expected}.`,
            rule: 'schema/invalid-type',
          },
          value,
        ),
      ]
  }

  return [
    withValue(
      {
        path: formatted,
        message: endWithPeriod(issue.message),
        rule: `schema/${issue.code}`,
      },
      value,
    ),
  ]
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`
  if (value === undefined) return 'A missing value'
  return JSON.stringify(value) ?? String(value)
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function endWithPeriod(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`
}
