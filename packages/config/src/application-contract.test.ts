import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { minimalConfig } from '../test/helpers.js'
import { compileToolSchema, ConfigSchema, defineConfig, validateConfig } from './index.js'

const tool = {
  name: 'lookup',
  description: 'Read application data.',
  readOnly: true,
  parameters: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'string' },
  execute: () => 'ok',
}

describe('complete application registrations', () => {
  it.each(['name', 'description', 'parameters', 'outputSchema', 'execute'])(
    'requires %s',
    (field) => {
      const incomplete = Object.fromEntries(Object.entries(tool).filter(([key]) => key !== field))
      expect(validateConfig({ ...minimalConfig(), tools: [incomplete] }, { env: {} }).ok).toBe(
        false,
      )
    },
  )
  it('rejects multiple executable handlers', () => {
    expect(
      validateConfig(
        { ...minimalConfig(), tools: [{ ...tool, executor: { type: 'client', id: 'lookup' } }] },
        { env: {} },
      ).ok,
    ).toBe(false)
  })
  it.each([
    { type: 'object', unsupportedConstraint: true },
    { type: 'object', properties: { name: { type: 'string', pattern: '[' } } },
    { type: 'object', $ref: '#/$defs/missing' },
    { type: 'object', $schema: 'https://example.test/unknown-dialect' },
    { type: 'object', $async: true },
    { type: 'object', properties: { n: { type: 'number', minimum: 'no' } } },
    { _zod: {}, safeParse: () => ({ success: true }) },
    z.date(),
  ])('rejects invalid/unsupported schemas at configuration: %j', (schema) => {
    const result = validateConfig(
      { ...minimalConfig(), tools: [{ ...tool, parameters: schema }] },
      { env: {} },
    )
    expect(result.ok).toBe(false)
  })
  it.each([undefined, ['lookup'], ['*']])('rejects bulk MCP discovery with allow=%j', (allow) => {
    expect(
      validateConfig(
        {
          ...minimalConfig(),
          tools: [
            {
              from: 'mcp',
              id: 'remote',
              allow,
              readOnly: true,
              server: { transport: 'http', url: 'https://example.test/mcp' },
            },
          ],
        },
        { env: {} },
      ).ok,
    ).toBe(false)
  })
  it('rejects wildcard single-tool MCP executors', () => {
    expect(
      validateConfig(
        {
          ...minimalConfig(),
          tools: [
            {
              ...tool,
              execute: undefined,
              executor: {
                type: 'mcp',
                tool: '*',
                server: { transport: 'http', url: 'https://example.test/mcp' },
              },
            },
          ],
        },
        { env: {} },
      ).ok,
    ).toBe(false)
  })
})

describe('standards-based schema validation', () => {
  it.each([
    [
      {
        type: 'object',
        properties: { n: { type: 'number', minimum: 1, maximum: 2 } },
        additionalProperties: false,
      },
      { n: 1 },
      { n: 1, x: 2 },
    ],
    [{ type: 'string', minLength: 2, maxLength: 3 }, 'ab', 'abcd'],
    [
      { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'integer' } },
      [1],
      [1, 1],
    ],
    [
      {
        oneOf: [
          { type: 'number', maximum: 3 },
          { type: 'string', minLength: 2 },
        ],
      },
      'ok',
      true,
    ],
    [
      {
        allOf: [
          { type: 'number', minimum: 1 },
          { not: { const: 2 } },
          { anyOf: [{ const: 1 }, { const: 3 }] },
        ],
      },
      3,
      2,
    ],
    [
      {
        type: 'object',
        properties: { kind: { enum: ['a', 'b'] }, n: { type: 'number' } },
        required: ['kind'],
        if: { properties: { kind: { const: 'a' } } },
        then: { required: ['n'] },
      },
      { kind: 'b' },
      { kind: 'a' },
    ],
    [
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { x: { type: 'integer' } },
        unevaluatedProperties: false,
      },
      { x: 1 },
      { x: 1, y: 2 },
    ],
  ])('enforces bounds and combinators: %j', async (schema, valid, invalid) => {
    const compiled = compileToolSchema(schema)
    expect(await compiled.parse(valid)).toEqual({ ok: true, value: valid })
    expect(await compiled.parse(invalid)).toEqual({ ok: false })
  })
  it('translates Zod input into provider JSON Schema', () => {
    const compiled = compileToolSchema(
      z.object({ count: z.string().min(2).transform(Number) }),
      true,
    )
    expect(compiled.jsonSchema).toMatchObject({
      type: 'object',
      properties: { count: { type: 'string', minLength: 2 } },
    })
    expect(JSON.stringify(compiled.jsonSchema)).not.toContain('_zod')
  })
})

describe('prompt.system server-only resolver', () => {
  it('accepts a contextually typed resolver in typed config and rejects it in declarative config', () => {
    const config = defineConfig({
      version: 1,
      name: 'Test',
      backend: { provider: 'anthropic', model: 'offline' },
      prompt: { system: async (ctx) => `${ctx.locale}:${ctx.identity?.sub ?? ctx.sessionId}` },
    })
    expect(validateConfig(config, { env: {} }).ok).toBe(true)
    expect(ConfigSchema.safeParse(config).success).toBe(false)
  })
  it('rejects the removed prompt hook', () => {
    expect(
      validateConfig(
        {
          ...minimalConfig(),
          prompt: { system: () => 'instructions' },
          hooks: { onPromptComposed: () => 'replace' },
        },
        { env: {} },
      ).ok,
    ).toBe(false)
  })
  it.each([0, 10_001])('rejects an unbounded/invalid resolver timeout %s', (systemTimeoutMs) => {
    expect(
      validateConfig(
        { ...minimalConfig(), prompt: { system: 'instructions', systemTimeoutMs } },
        { env: {} },
      ).ok,
    ).toBe(false)
  })
})

describe('removed framework subsystems', () => {
  it('fails clearly for removed knowledge configuration, including empty objects', () => {
    const result = validateConfig({ ...minimalConfig(), knowledge: {} }, { env: {} })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'knowledge',
          rule: 'schema/removed-option',
          message: expect.stringContaining('has been removed'),
        }),
      )
  })
  it('rejects builtin executors', () => {
    expect(
      validateConfig(
        {
          ...minimalConfig(),
          tools: [{ ...tool, execute: undefined, executor: { type: 'builtin', id: 'get_time' } }],
        },
        { env: {} },
      ).ok,
    ).toBe(false)
  })
})
