/**
 * `extends` merge semantics — docs/02-configuration.md §1.
 *
 * | Kind                  | Rule                                                |
 * | --------------------- | --------------------------------------------------- |
 * | Scalars, objects      | Deep merge; the overriding file wins.               |
 * | Arrays of primitives  | Replaced wholesale.                                 |
 * | `tools[]`             | Merged by `name`; same name replaces, new appends.  |
 * | `knowledge.sources[]` | Concatenated — both apply.                          |
 * | `hooks`               | Code only, so it can only ever come from the top.   |
 *
 * Arrays that are neither `tools` nor `knowledge.sources` are replaced rather
 * than concatenated. Concatenating `backend.fallback` or `ui.messages.suggestions`
 * would make it impossible for a TS config to *shorten* a list it inherited,
 * and silently-growing lists are much harder to debug than an explicit rewrite.
 */

/** Arrays merged by identity rather than replaced. */
const MERGE_BY_KEY = new Set(['tools'])
/** Arrays where both sides apply. */
const CONCATENATE = new Set(['knowledge.sources'])

export function mergeConfigs(base: unknown, override: unknown): unknown {
  return merge(base, override, '')
}

/** Fold a chain of configs left to right; later entries win. */
export function mergeConfigChain(configs: readonly unknown[]): unknown {
  return configs.reduce((accumulator, config) => mergeConfigs(accumulator, config), {} as unknown)
}

function merge(base: unknown, override: unknown, path: string): unknown {
  if (override === undefined) return base
  if (base === undefined) return override

  if (Array.isArray(base) && Array.isArray(override)) {
    if (CONCATENATE.has(path)) return [...base, ...override]
    if (MERGE_BY_KEY.has(path)) return mergeByKey(base, override)
    return override
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override)) {
      out[key] = merge(base[key], value, path === '' ? key : `${path}.${key}`)
    }
    return out
  }

  return override
}

/**
 * Identity for a `tools[]` entry: its `name`, or `mcp:<id>` for the bulk import
 * form. Entries without either are always appended — there is nothing to match
 * them on, and dropping one silently would be worse than a duplicate.
 */
function entryKey(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null
  if (entry['from'] === 'mcp') {
    return typeof entry['id'] === 'string' ? `mcp:${entry['id']}` : null
  }
  return typeof entry['name'] === 'string' ? entry['name'] : null
}

function mergeByKey(base: unknown[], override: unknown[]): unknown[] {
  const out = [...base]
  const index = new Map<string, number>()
  base.forEach((entry, position) => {
    const key = entryKey(entry)
    if (key !== null && !index.has(key)) index.set(key, position)
  })

  for (const entry of override) {
    const key = entryKey(entry)
    const position = key === null ? undefined : index.get(key)
    if (position === undefined) {
      if (key !== null) index.set(key, out.length)
      out.push(entry)
    } else {
      // A same-named tool replaces outright rather than deep-merging. Half a
      // YAML `http` executor blended into a TS `execute` handler is not a thing
      // anyone wants; docs/02 §1 says "replaces" and means it.
      out[position] = entry
    }
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
