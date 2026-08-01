import { describe, expect, it } from 'vitest'
import { CHUNK_STRATEGIES, SOURCE_TYPES } from './index.js'

describe('@sitebot/ingest', () => {
  it('supports every source type named in docs/02 §9', () => {
    expect(SOURCE_TYPES).toContain('sitemap')
    expect(SOURCE_TYPES).toContain('crawl')
    expect(SOURCE_TYPES).toContain('files')
  })

  it('offers three chunking strategies', () => {
    expect(CHUNK_STRATEGIES).toHaveLength(3)
  })
})
