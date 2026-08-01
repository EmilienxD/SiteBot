import { describe, expect, it } from 'vitest'
import { CONFIG_FILENAMES, CONFIG_SCHEMA_VERSION } from './index.js'

describe('@sitebot/config', () => {
  it('pins the schema version at 1', () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(1)
  })

  it('resolves TS config files before declarative ones (docs/02 §1)', () => {
    const firstYaml = CONFIG_FILENAMES.indexOf('chatbot.config.yaml')
    const lastTs = CONFIG_FILENAMES.indexOf('chatbot.config.mjs')
    expect(lastTs).toBeLessThan(firstYaml)
  })
})
