/**
 * Walking a Zod schema to recover "what keys were legal here?".
 *
 * Zod reports an unrecognised key with a path but not with the set of keys it
 * would have accepted, and that set is exactly what a "did you mean" needs.
 * Rather than duplicate the schema as a hand-written key list — which would
 * drift the first time someone adds a field — we resolve it from the schema
 * itself and degrade to no suggestion if the shape is something we do not
 * recognise.
 */

interface ZodDef {
  type?: string
  shape?: Record<string, unknown>
  element?: unknown
  options?: unknown[]
  in?: unknown
  out?: unknown
  innerType?: unknown
  getter?: () => unknown
}

function defOf(schema: unknown): ZodDef | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const internal = (schema as { _zod?: { def?: unknown } })._zod
  if (!internal || typeof internal.def !== 'object' || internal.def === null) {
    return undefined
  }
  return internal.def as ZodDef
}

/** Peel wrappers (optional, default, prefault, pipe, lazy, …) off a schema. */
function unwrap(schema: unknown, depth = 0): unknown {
  if (depth > 16) return schema
  const def = defOf(schema)
  if (!def) return schema

  if (def.type === 'pipe' && def.in !== undefined) {
    return unwrap(def.in, depth + 1)
  }
  if (def.type === 'lazy' && typeof def.getter === 'function') {
    return unwrap(def.getter(), depth + 1)
  }
  if (def.innerType !== undefined) {
    return unwrap(def.innerType, depth + 1)
  }
  return schema
}

/** Every branch of a union, or the schema itself. */
function branches(schema: unknown): unknown[] {
  const def = defOf(unwrap(schema))
  if (def?.options && Array.isArray(def.options)) return def.options
  return [unwrap(schema)]
}

/** Step into one path segment. Returns every schema that could sit there. */
function descend(schemas: unknown[], segment: PropertyKey): unknown[] {
  const next: unknown[] = []
  for (const schema of schemas) {
    for (const branch of branches(schema)) {
      const def = defOf(branch)
      if (!def) continue
      if (typeof segment === 'number') {
        if (def.element !== undefined) next.push(def.element)
      } else if (def.shape) {
        const child = def.shape[String(segment)]
        if (child !== undefined) next.push(child)
      }
    }
  }
  return next
}

/**
 * Keys accepted by the object at `path`, across every union branch.
 * Empty when the path does not lead to an object.
 */
export function keysAtPath(root: unknown, path: readonly PropertyKey[]): string[] {
  let current: unknown[] = [root]
  for (const segment of path) {
    current = descend(current, segment)
    if (current.length === 0) return []
  }

  const keys = new Set<string>()
  for (const schema of current) {
    for (const branch of branches(schema)) {
      const def = defOf(branch)
      if (def?.shape) for (const key of Object.keys(def.shape)) keys.add(key)
    }
  }
  return [...keys]
}
