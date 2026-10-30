import { describe, expect, it } from 'vitest'
import { errorsFor, minimalConfig } from '../test/helpers.js'
import {
  didYouMean,
  formatConfigError,
  formatConfigErrors,
  formatPath,
  levenshtein,
} from './index.js'

describe('formatPath', () => {
  it('renders object keys, array indices and awkward keys', () => {
    expect(formatPath(['tools', 0, 'executor', 'url'])).toBe('tools[0].executor.url')
    expect(formatPath(['ui', 'strings', 'fr', 'greeting'])).toBe('ui.strings.fr.greeting')
    expect(formatPath(['headers', 'anthropic-beta'])).toBe('headers["anthropic-beta"]')
    expect(formatPath([])).toBe('')
  })
})

describe('levenshtein', () => {
  it('measures edit distance', () => {
    expect(levenshtein('mode', 'mode')).toBe(0)
    expect(levenshtein('modee', 'mode')).toBe(1)
    expect(levenshtein('maxOutputTokns', 'maxOutputTokens')).toBe(1)
    expect(levenshtein('', 'abc')).toBe(3)
  })

  it('short-circuits past the cap without lying about ordering', () => {
    expect(levenshtein('abcdef', 'uvwxyz', 2)).toBeGreaterThan(2)
  })
})

describe('didYouMean', () => {
  it('finds a near miss', () => {
    expect(didYouMean('maxOutputTokns', ['maxOutputTokens', 'maxRetries'])).toBe('maxOutputTokens')
  })

  it('is case-insensitive but returns the canonical spelling', () => {
    expect(didYouMean('MaxRetries', ['maxRetries'])).toBe('maxRetries')
  })

  it('stays quiet rather than guessing wildly', () => {
    // `mode` → `node` is distance 1, but on a four-character word a confident
    // wrong suggestion is worse than none.
    expect(didYouMean('zzzz', ['maxOutputTokens', 'temperature'])).toBeUndefined()
    expect(didYouMean('anything', [])).toBeUndefined()
  })
})

describe('unknown keys are errors with a suggestion (docs/02 §14)', () => {
  it('suggests the intended top-level key', () => {
    const errors = errorsFor({ ...minimalConfig(), moode: 'chat' })
    const error = errors.find((e) => e.rule === 'schema/unknown-key')

    expect(error?.path).toBe('moode')
    expect(error?.message).toBe('Unknown key "moode".')
    expect(error?.suggestion).toBe('mode')
    expect(error?.expected).toContain('mode')
  })

  it('suggests a nested key at its full path', () => {
    const errors = errorsFor({
      ...minimalConfig(),
      backend: {
        provider: 'anthropic',
        model: 'claude-opus-5',
        maxOutputTokns: 512,
      },
    })
    const error = errors.find((e) => e.rule === 'schema/unknown-key')

    expect(error?.path).toBe('backend.maxOutputTokns')
    expect(error?.suggestion).toBe('maxOutputTokens')
  })

  it('resolves keys through an array of union members', () => {
    const errors = errorsFor({
      ...minimalConfig(),
      tools: [
        {
          name: 'lookup',
          description: 'Read data.',
          readOnly: true,
          parameters: { type: 'object' },
          outputSchema: {},
          executor: { type: 'http', url: 'https://example.test', maxRedirect: 1 },
        },
      ],
    })
    const error = errors.find((e) => e.rule === 'schema/unknown-key')

    expect(error?.path).toBe('tools[0].executor.maxRedirect')
    expect(error?.suggestion).toBe('maxRedirects')
  })

  it('names the variant when a key belongs to a different `type`', () => {
    const errors = errorsFor({ ...minimalConfig(), storage: { type: 'memory', path: './s.db' } })
    const error = errors.find((e) => e.rule === 'schema/unknown-key')

    expect(error?.path).toBe('storage.path')
    expect(error?.message).toBe('Key "path" does not apply when type is "memory".')
    expect(error?.suggestion).toBeUndefined()
  })

  it('says so plainly when nothing is close', () => {
    const errors = errorsFor({ ...minimalConfig(), wibble: true })
    const error = errors.find((e) => e.rule === 'schema/unknown-key')

    expect(error?.suggestion).toBeUndefined()
    expect(error?.fix).toContain('docs/02-configuration.md')
  })
})

describe('invalid values', () => {
  it('lists the accepted values and suggests the nearest', () => {
    const errors = errorsFor({
      ...minimalConfig(),
      backend: { provider: 'anthropc', model: 'claude-opus-5' },
    })
    const error = errors.find((e) => e.path === 'backend.provider')

    expect(error?.message).toBe('"anthropc" is not valid here.')
    expect(error?.expected).toContain('anthropic')
    expect(error?.suggestion).toBe('anthropic')
  })

  it('reports a missing required field as a type error with a fix', () => {
    const errors = errorsFor({ version: 1, name: 'Acme', prompt: { system: 'x' } })
    const error = errors.find((e) => e.path === 'backend')

    expect(error?.message).toContain('received undefined')
    expect(error?.fix).toBe('This field is required.')
  })

  it('picks the closest branch of a union instead of every branch', () => {
    const errors = errorsFor({
      ...minimalConfig(),
      tools: [
        {
          parameters: { type: 'object' },
          outputSchema: {},
          name: 'lookup',
          description: 'Look something up in the catalogue.',
          readOnly: true,
          executor: { type: 'http' },
        },
      ],
    })

    // The five-way executor union would otherwise produce a wall of
    // "expected literal mcp / module / client" noise.
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('tools[0].executor.url')
  })
})

describe('rendering', () => {
  it('prints path, value, expectation, suggestion and fix', () => {
    const rendered = formatConfigError({
      path: 'backend.provider',
      message: '"anthropc" is not valid here.',
      value: 'anthropc',
      expected: 'anthropic | openai',
      suggestion: 'anthropic',
      fix: 'Use one of: anthropic, openai.',
    })

    expect(rendered).toBe(
      [
        '✖ backend.provider',
        '    "anthropc" is not valid here.',
        '    value:     "anthropc"',
        '    expected:  anthropic | openai',
        '    did you mean "anthropic"?',
        '    fix:       Use one of: anthropic, openai.',
      ].join('\n'),
    )
  })

  it('names the file in the header', () => {
    const rendered = formatConfigErrors(
      [{ path: 'name', message: 'Required.' }],
      '/app/chatbot.config.yaml',
    )
    expect(rendered.split('\n')[0]).toBe('Invalid configuration in /app/chatbot.config.yaml:')
  })

  it('counts the problems when there is more than one', () => {
    const rendered = formatConfigErrors([
      { path: 'a', message: 'One.' },
      { path: 'b', message: 'Two.' },
    ])
    expect(rendered.split('\n')[0]).toBe('2 problems in the configuration:')
  })
})
