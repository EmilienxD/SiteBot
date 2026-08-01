/**
 * Shared result and diagnostic types.
 *
 * Everything here is browser-safe: no Node APIs, no filesystem, no `process`
 * beyond what the caller passes in explicitly.
 */

/** Where the resolved config is going to run. Drives cross-field rule 6. */
export type BuildTarget = 'node' | 'edge'

/**
 * A single validation failure, shaped so it can be printed as something a
 * developer can act on: docs/02-configuration.md §14 requires the path, the
 * offending value, the expectation, and a fix.
 */
export interface ConfigError {
  /** Dot/bracket path into the config, e.g. `tools[0].executor.url`. */
  path: string
  /** One-line statement of what is wrong. Stable — tests assert on it. */
  message: string
  /** The value that was rejected, when there is one. */
  value?: unknown
  /** What would have been accepted. */
  expected?: string
  /** What to do about it. */
  fix?: string
  /** Nearest known key or value, via Levenshtein distance. */
  suggestion?: string
  /** Identifies the rule, e.g. `cross-field/3`. Useful in tests and docs. */
  rule?: string
}

/** A non-fatal finding. The config still loads. */
export interface ConfigWarning {
  path: string
  message: string
  fix?: string
  rule?: string
}

export type Result<T, E> =
  { ok: true; value: T; warnings: ConfigWarning[] } | { ok: false; errors: E }

/**
 * How a config was resolved. Carried on {@link ResolvedConfig} because
 * `toPublicConfig` needs `envPaths` to make the "no env-sourced value reaches
 * the browser" guarantee mechanical rather than a matter of remembering to
 * update an allowlist (docs/08-security.md §2).
 */
export interface ResolutionMeta {
  /** Absolute path of the file this came from, or `null` for an inline object. */
  sourcePath: string | null
  /** Directory that relative paths inside the config resolve against. */
  baseDir: string | null
  /** Files pulled in via `extends`, in application order. */
  extendsChain: readonly string[]
  /**
   * Paths whose string value contained `${env.*}`.
   *
   * Recorded whether or not the variable was actually set — a `${env.X:-fallback}`
   * that fell back is still marked. Keeping this independent of the ambient
   * environment is what makes `toPublicConfig` produce the same shape in dev and
   * in production; a field that is public on one machine and missing on another
   * would be a nasty way to find out about a leak.
   */
  envPaths: readonly string[]
  target: BuildTarget
}
