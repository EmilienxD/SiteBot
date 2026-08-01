import { childPath } from './errors.js'
import type { ConfigError } from './types.js'

/**
 * `${env.VAR}` interpolation — docs/02-configuration.md §2.
 *
 *   ${env.API_KEY}            required; missing is a fatal validation error
 *   ${env.PORT:-3000}         falls back to the literal after `:-`
 *
 * Applied to string *values* only, never to keys, and never inside the two
 * exempt regions below.
 */
const PLACEHOLDER = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** Cheap pre-check so we can skip the regex machinery on ordinary strings. */
export function containsEnvPlaceholder(value: string): boolean {
  return value.includes('${env.')
}

export interface InterpolateOptions {
  /** The environment to read from. Never touched unless a placeholder needs it. */
  env: Readonly<Record<string, string | undefined>>
  /**
   * Paths left completely alone. Defaults to {@link isExemptFromEnv}.
   * Exempt regions keep their literal `${env.…}` text.
   */
  isExempt?: (path: string) => boolean
}

export interface InterpolateResult<T> {
  value: T
  /** Paths whose string contained at least one placeholder. */
  envPaths: string[]
  errors: ConfigError[]
}

/**
 * The two regions where interpolation must not happen:
 *
 * - `prompt.system` — prompts are literal text. Substituting there would let a
 *   secret slide into the model context by accident; `prompt.variables` is the
 *   supported way to parameterise a prompt (docs/02 §2 and §5).
 * - `ui.*` — the whole block is shipped to the browser, so an env value has no
 *   business being there at all. Leaving the placeholder intact lets
 *   cross-field rule 10 report it against the text the developer actually
 *   wrote, rather than against a resolved secret we would then have to redact.
 */
export function isExemptFromEnv(path: string): boolean {
  return path === 'prompt.system' || path === 'ui' || path.startsWith('ui.')
}

/**
 * Resolve every `${env.*}` in `input`, recording where they were.
 *
 * Returns a new value; `input` is not mutated.
 */
export function interpolateEnv<T>(input: T, options: InterpolateOptions): InterpolateResult<T> {
  const isExempt = options.isExempt ?? isExemptFromEnv
  const envPaths: string[] = []
  const errors: ConfigError[] = []

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') {
      if (isExempt(path) || !containsEnvPlaceholder(node)) return node
      envPaths.push(path)
      return resolveString(node, path, options.env, errors)
    }
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, childPath(path, index)))
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(node)) {
        out[key] = walk(value, childPath(path, key))
      }
      return out
    }
    return node
  }

  return { value: walk(input, '') as T, envPaths, errors }
}

function resolveString(
  raw: string,
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  errors: ConfigError[],
): string {
  return raw.replace(PLACEHOLDER, (match, name: string, fallback?: string) => {
    const value = env[name]
    if (value !== undefined && value !== '') return value
    if (fallback !== undefined) return fallback

    errors.push({
      path,
      message: `Environment variable ${name} is not set.`,
      value: match,
      expected: `${name} to be present in the environment`,
      fix: `Export ${name}, add it to your .env file, or give it a default: \${env.${name}:-someValue}`,
      rule: 'env/missing-variable',
    })
    // The value is meaningless now, but validation continues so the developer
    // sees every missing variable at once instead of one per run.
    return match
  })
}

/**
 * True for objects we should recurse into. Class instances (a Zod schema on a
 * `tools[].parameters`, a Date) are values, not containers.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Does `path` (or an ancestor of it) hold an env-sourced value?
 *
 * Prefix matching is what makes the guarantee hold for objects: if
 * `security.auth.jwt.secret` came from the environment then so did everything
 * under it, and a caller asking about the parent gets the right answer.
 */
export function isEnvSourced(path: string, envPaths: readonly string[]): boolean {
  for (const sourced of envPaths) {
    if (sourced === path) return true
    if (
      path.startsWith(sourced) &&
      (path[sourced.length] === '.' || path[sourced.length] === '[')
    ) {
      return true
    }
  }
  return false
}
