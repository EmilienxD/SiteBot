import { Ajv } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { default as formats } from 'ajv-formats'
import { z } from 'zod'

export type ToolSchema = Record<string, unknown> | z.ZodType
export interface CompiledToolSchema {
  jsonSchema: Record<string, unknown>
  validate(value: unknown): boolean
  parse(value: unknown): Promise<{ ok: true; value: unknown } | { ok: false }>
}

/** Compile at configuration/registration, never accept unknown keywords silently. */
export function compileToolSchema(schema: ToolSchema, input = false): CompiledToolSchema {
  try {
    const native = schema instanceof z.ZodType ? schema : undefined
    const json = native ? z.toJSONSchema(native, { target: 'draft-07', io: 'input' }) : schema
    // Reject non-JSON definitions instead of dropping executable/unsupported values.
    const encoded = JSON.stringify(json, (_key, value: unknown) => {
      if (
        typeof value === 'function' ||
        typeof value === 'symbol' ||
        typeof value === 'bigint' ||
        value === undefined ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        throw new Error()
      return value
    })
    const jsonSchema = JSON.parse(encoded) as Record<string, unknown>
    if (
      !jsonSchema ||
      Array.isArray(jsonSchema) ||
      typeof jsonSchema !== 'object' ||
      (input && jsonSchema.type !== 'object')
    )
      throw new Error()
    const options = {
      allErrors: true,
      strict: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      addUsedSchema: false,
      ownProperties: true,
      // Compilation failures must not log generated source or application schema constants.
      logger: false as const,
    }
    const dialect = jsonSchema.$schema
    const ajv =
      typeof dialect === 'string' && dialect.includes('2020-12')
        ? new Ajv2020(options)
        : typeof dialect === 'string' && dialect.includes('2019-09')
          ? new Ajv2019(options)
          : new Ajv(options)
    formats(ajv)
    const validate = ajv.compile(jsonSchema)
    if ('$async' in validate && validate.$async) throw new Error()
    return {
      jsonSchema,
      validate: (value) => validate(value) === true,
      async parse(value) {
        try {
          if (native) {
            const parsed = await native.safeParseAsync(value)
            return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
          }
          return validate(value) ? { ok: true, value } : { ok: false }
        } catch {
          return { ok: false }
        }
      },
    }
  } catch {
    throw new Error('Invalid or unsupported tool schema.')
  }
}
