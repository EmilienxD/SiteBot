import { describe, expect, it } from 'vitest'
import {
  ArgError,
  didYouMean,
  formatFlags,
  GLOBAL_FLAGS,
  parseArgs,
  type FlagSpecs,
} from './args.js'

const SPECS: FlagSpecs = {
  port: { type: 'number', summary: 'Port.', short: 'p' },
  host: { type: 'string', summary: 'Host.' },
  open: { type: 'boolean', summary: 'Open a browser.', short: 'o' },
  'dry-run': { type: 'boolean', summary: 'Dry run.' },
}

describe('parseArgs', () => {
  it('parses positionals, long flags and short aliases', () => {
    const parsed = parseArgs(['file.ts', '--port', '3000', '-o', '--host=demo'], SPECS)
    expect(parsed.positionals).toEqual(['file.ts'])
    expect(parsed.flags).toEqual({ port: 3000, open: true, host: 'demo' })
  })

  it('treats everything after -- as positional', () => {
    const parsed = parseArgs(['--port', '1', '--', '--port', '2'], SPECS)
    expect(parsed.flags).toEqual({ port: 1 })
    expect(parsed.positionals).toEqual(['--port', '2'])
  })

  it('accepts --no-foo as the negation of a boolean foo', () => {
    expect(parseArgs(['--no-open'], SPECS).flags).toEqual({ open: false })
    expect(parseArgs(['--no-dry-run'], SPECS).flags).toEqual({ 'dry-run': false })
  })

  it('accepts explicit boolean values', () => {
    expect(parseArgs(['--open=true'], SPECS).flags).toEqual({ open: true })
    expect(parseArgs(['--open=false'], SPECS).flags).toEqual({ open: false })
    expect(() => parseArgs(['--open=maybe'], SPECS)).toThrow(ArgError)
  })

  it('suggests the closest flag on typos', () => {
    try {
      parseArgs(['--pport', '1'], SPECS)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ArgError)
      expect((error as ArgError).fix).toBe('Did you mean --port?')
    }
    expect(() => parseArgs(['--zzzzz'], SPECS)).toThrowError(/Unknown option/)
  })

  it('rejects a string flag whose value is missing or another flag', () => {
    expect(() => parseArgs(['--host'], SPECS)).toThrowError(/--host needs a value/)
    expect(() => parseArgs(['--host', '--open'], SPECS)).toThrowError(/--host needs a value/)
  })

  it('rejects a non-numeric value for a number flag', () => {
    expect(() => parseArgs(['--port', 'abc'], SPECS)).toThrowError(/--port must be a number/)
  })
})

describe('didYouMean', () => {
  it('points at near misses and stays quiet on noise', () => {
    expect(didYouMean('heatlh', ['health', 'help'])).toBe('Did you mean --health?')
    expect(didYouMean('zzz', ['health'])).toBeUndefined()
  })
})

describe('formatFlags', () => {
  it('renders aligned rows with shorts and placeholders', () => {
    const lines = formatFlags({ ...SPECS, config: GLOBAL_FLAGS['config']! })
    expect(lines.some((line) => line.includes('-p, --port'))).toBe(true)
    expect(lines.some((line) => line.includes('-c, --config <path>'))).toBe(true)
    expect(lines.every((line) => line.startsWith('  '))).toBe(true)
  })
})
