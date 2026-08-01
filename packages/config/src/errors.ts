import type { ConfigError, ConfigWarning } from './types.js'

/**
 * Thrown by `loadConfig` when validation fails. Carries the structured errors
 * so a caller (the CLI, a test) can render them however it likes; `message` is
 * the already-formatted block for callers that just want to print it.
 */
export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError'
  readonly errors: ConfigError[]
  readonly warnings: ConfigWarning[]
  readonly sourcePath: string | null

  constructor(
    errors: ConfigError[],
    opts: { sourcePath?: string | null; warnings?: ConfigWarning[] } = {},
  ) {
    super(formatConfigErrors(errors, opts.sourcePath ?? null))
    this.errors = errors
    this.warnings = opts.warnings ?? []
    this.sourcePath = opts.sourcePath ?? null
  }
}

/** Raised for problems that stop us reaching validation at all. */
export class ConfigLoadError extends Error {
  override readonly name = 'ConfigLoadError'
  readonly fix: string | undefined

  constructor(message: string, opts: { fix?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause })
    this.fix = opts.fix
  }
}

// ── paths ───────────────────────────────────────────────────────────────────

const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Render a Zod-style path array as `tools[0].executor.url`. */
export function formatPath(segments: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${segment}]`
    else if (typeof segment === 'symbol') out += `[${String(segment)}]`
    else if (BARE_KEY.test(segment)) out += out === '' ? segment : `.${segment}`
    else out += `[${JSON.stringify(segment)}]`
  }
  return out
}

/** Append a single segment to an already-formatted path. */
export function childPath(parent: string, segment: PropertyKey): string {
  if (typeof segment === 'number') return `${parent}[${segment}]`
  const key = String(segment)
  if (!BARE_KEY.test(key)) return `${parent}[${JSON.stringify(key)}]`
  return parent === '' ? key : `${parent}.${key}`
}

// ── did-you-mean ────────────────────────────────────────────────────────────

/**
 * Levenshtein distance, with an early exit once the running minimum exceeds
 * `max`. Config keys are short, so the two-row form is plenty.
 */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  if (Math.abs(a.length - b.length) > max) return max + 1

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  let current = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      )
      current[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return max + 1
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length] as number
}

/**
 * Nearest candidate to `input`, or `undefined` when nothing is close enough.
 *
 * The threshold scales with length so `mode` → `node` (distance 2 on a 4-char
 * word) does not produce a confident-sounding wrong guess, while
 * `maxOutputTokns` → `maxOutputTokens` does.
 */
export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined
  const lower = input.toLowerCase()
  const threshold = Math.max(1, Math.floor(input.length / 3))

  let best: string | undefined
  let bestDistance = Infinity

  for (const candidate of candidates) {
    // A pure case or separator difference is always the intended key.
    if (candidate.toLowerCase() === lower) return candidate
    const distance = levenshtein(lower, candidate.toLowerCase(), threshold)
    if (distance <= threshold && distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

// ── formatting ──────────────────────────────────────────────────────────────

const MAX_INLINE_VALUE = 120

function renderValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > MAX_INLINE_VALUE ? `${text.slice(0, MAX_INLINE_VALUE)}…` : text
}

/** One diagnostic, indented as a block. */
export function formatConfigError(error: ConfigError): string {
  const lines = [`✖ ${error.path === '' ? '(root)' : error.path}`]
  lines.push(`    ${error.message}`)
  if ('value' in error) lines.push(`    value:     ${renderValue(error.value)}`)
  if (error.expected) lines.push(`    expected:  ${error.expected}`)
  if (error.suggestion) lines.push(`    did you mean "${error.suggestion}"?`)
  if (error.fix) lines.push(`    fix:       ${error.fix}`)
  return lines.join('\n')
}

export function formatConfigWarning(warning: ConfigWarning): string {
  const lines = [`⚠ ${warning.path === '' ? '(root)' : warning.path}`]
  lines.push(`    ${warning.message}`)
  if (warning.fix) lines.push(`    fix:       ${warning.fix}`)
  return lines.join('\n')
}

/** The whole set, with a header naming the file the developer has to open. */
export function formatConfigErrors(
  errors: readonly ConfigError[],
  sourcePath: string | null = null,
): string {
  const header =
    errors.length === 1
      ? `Invalid configuration${sourcePath ? ` in ${sourcePath}` : ''}:`
      : `${errors.length} problems in the configuration${sourcePath ? ` (${sourcePath})` : ''}:`
  return [header, '', ...errors.map(formatConfigError)].join('\n')
}
