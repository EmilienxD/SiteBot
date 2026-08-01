import { describe, expect, it } from 'vitest'
import { COMMANDS } from './index.js'

describe('@sitebot/cli', () => {
  it('declares the six documented commands', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      'init',
      'validate',
      'ingest',
      'dev',
      'serve',
      'doctor',
    ])
  })

  it('gives every command a summary for --help', () => {
    for (const command of COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(0)
    }
  })
})
