/** Glob match for `hideOnPaths`, `excludePaths` and friends: `*` is the only wildcard. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(
      path,
    ),
  )
}
