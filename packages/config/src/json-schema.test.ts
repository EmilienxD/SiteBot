import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { loadYamlFixture, minimalConfig } from '../test/helpers.js'
import { emitJsonSchema, JSON_SCHEMA_PATH } from './index.js'

/**
 * The published schema is what gives a developer autocomplete and inline
 * validation in VS Code (docs/02-configuration.md §14). The shape assertions
 * below are the mechanical half of that promise; the editor experience itself
 * was verified once by hand against the kitchen-sink fixture, which carries the
 * `# yaml-language-server: $schema=…` line.
 */

const schema = emitJsonSchema() as Record<string, any>

describe('emitJsonSchema', () => {
  it('emits draft-07 with a stable id', () => {
    expect(schema['$schema']).toBe('http://json-schema.org/draft-07/schema#')
    expect(schema['$id']).toContain('chatbot.schema.json')
    expect(schema['title']).toBe('SiteBot configuration')
    expect(JSON_SCHEMA_PATH).toBe('schema/chatbot.schema.json')
  })

  it('requires exactly the fields a developer must write', () => {
    // Everything else carries a default, so `io: "input"` must leave it
    // optional — otherwise a valid file lights up red in the editor.
    expect([...schema['required']].sort()).toEqual(['backend', 'name', 'prompt', 'version'])
  })

  it('describes every top-level section', () => {
    expect(Object.keys(schema['properties']).sort()).toEqual(
      [
        'agent',
        'backend',
        'extends',
        'knowledge',
        'mode',
        'name',
        'prompt',
        'security',
        'siteContext',
        'storage',
        'telemetry',
        'tools',
        'ui',
        'version',
      ].sort(),
    )
  })

  it('rejects unknown keys, so a typo is flagged in the editor', () => {
    expect(schema['additionalProperties']).toBe(false)
  })

  it('carries the enum options an editor completes from', () => {
    expect(schema['properties']['mode']['enum']).toEqual(['chat', 'agent'])
    expect(schema['properties']['backend']['properties']['provider']['enum']).toContain(
      'openai-compatible',
    )
  })

  it('carries the descriptions an editor shows on hover', () => {
    expect(schema['properties']['ui']['description']).toContain('Fully public')
    expect(schema['properties']['mode']['description']).toContain('policy switch')
  })

  it('excludes the code-only surface', () => {
    // `hooks` and inline `execute` handlers have no declarative equivalent, so
    // publishing them would tell a YAML author about keys they cannot use.
    expect(schema['properties']).not.toHaveProperty('hooks')
    expect(JSON.stringify(schema)).not.toContain('"execute"')
  })

  it('is JSON-serialisable', () => {
    expect(() => JSON.stringify(schema)).not.toThrow()
  })

  it('matches the committed snapshot', () => {
    // Guards against an accidental schema change slipping out in a patch
    // release: consumers pin this file by URL.
    expect(schema).toMatchSnapshot()
  })
})

/**
 * The half of "working autocomplete" that can be checked mechanically: a schema
 * that rejects a valid config paints the file red and gets the `$schema` line
 * deleted, which is worse than shipping no schema at all.
 */
describe('the emitted schema accepts what the Zod schema accepts', () => {
  const ajv = new Ajv({ strict: false, allErrors: true })
  const validate = ajv.compile(emitJsonSchema())

  it('compiles as draft-07', () => {
    expect(typeof validate).toBe('function')
  })

  it('accepts the kitchen-sink config', () => {
    const valid = validate(loadYamlFixture('kitchen-sink.yaml'))
    expect(validate.errors ?? []).toEqual([])
    expect(valid).toBe(true)
  })

  it('accepts a minimal config, so defaults really are optional', () => {
    expect(validate(minimalConfig())).toBe(true)
  })

  it('rejects an unknown key, which is what draws the squiggle', () => {
    expect(validate({ ...minimalConfig(), moode: 'chat' })).toBe(false)
  })

  it('rejects an invalid enum value', () => {
    expect(validate({ ...minimalConfig(), mode: 'agentic' })).toBe(false)
  })
})
