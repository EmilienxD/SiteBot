import { compileToolSchema } from '@sitebot/config'

/** Snapshot plain JSON values without invoking application getters/toJSON after validation. */
export function snapshotToolValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Invalid tool output.')
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('Invalid tool output.')
  ancestors.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const descriptor of Object.values(descriptors))
      if (descriptor.get || descriptor.set) throw new Error('Invalid tool output.')
    if (Array.isArray(value)) return value.map((child) => snapshotToolValue(child, ancestors))
    return Object.fromEntries(
      Object.entries(descriptors)
        .filter(([, descriptor]) => descriptor.enumerable)
        .map(([key, descriptor]) => [key, snapshotToolValue(descriptor.value, ancestors)]),
    )
  } finally {
    ancestors.delete(value)
  }
}

export interface JsonSchemaObject {
  type?: string
  properties?: Record<string, Record<string, unknown>>
  required?: string[]
  [key: string]: unknown
}

export interface SchemaIssue {
  path: string
  message: string
}

export interface SchemaResult<T = unknown> {
  ok: boolean
  value?: T
  issues?: SchemaIssue[]
}

export function validateJsonSchema(schema: JsonSchemaObject, input: unknown): SchemaResult {
  const compiled = compileToolSchema(schema)
  return compiled.validate(input)
    ? { ok: true, value: input }
    : { ok: false, issues: [{ path: '$', message: 'Invalid value.' }] }
}
