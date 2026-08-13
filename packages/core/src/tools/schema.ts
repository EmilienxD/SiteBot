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
  const issues: SchemaIssue[] = []
  validateNode(schema as Record<string, unknown>, input, '$', issues)
  return issues.length === 0 ? { ok: true, value: input } : { ok: false, issues }
}

function validateNode(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): void {
  const type = schema.type
  if (typeof type === 'string' && !matchesType(type, value)) {
    issues.push({ path, message: `expected ${type}` })
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value)))
    issues.push({ path, message: 'must be one of the declared values' })
  if (typeof schema.pattern === 'string' && typeof value === 'string') {
    try {
      if (!new RegExp(schema.pattern).test(value))
        issues.push({ path, message: 'does not match pattern' })
    } catch {
      issues.push({ path, message: 'uses an invalid pattern' })
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      issues.push({ path, message: `must be >= ${schema.minimum}` })
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      issues.push({ path, message: `must be <= ${schema.maximum}` })
  }
  if (isRecord(value) && type === 'object') {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const name of required)
      if (typeof name === 'string' && !(name in value))
        issues.push({ path: `${path}.${name}`, message: 'is required' })
    for (const [name, childSchema] of Object.entries(properties))
      if (name in value && isRecord(childSchema))
        validateNode(childSchema, value[name], `${path}.${name}`, issues)
  }
  if (Array.isArray(value) && isRecord(schema.items))
    value.forEach((item, index) =>
      validateNode(schema.items as Record<string, unknown>, item, `${path}[${index}]`, issues),
    )
}

function matchesType(type: string, value: unknown): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isRecord(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  return typeof value === type
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
