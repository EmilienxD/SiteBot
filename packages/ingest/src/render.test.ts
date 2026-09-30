import { describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright'
import { validateConfig } from '@sitebot/config'
import { loadCrawl, loadSitemap } from './sources.js'

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }))

describe('optional JavaScript renderer setup', () => {
  it.each(['crawl', 'sitemap'] as const)(
    '%s fails clearly when Chromium cannot launch',
    async (type) => {
      vi.mocked(chromium.launch).mockRejectedValueOnce(new Error('Executable does not exist'))
      const config = validateConfig(
        {
          version: 1,
          name: 'Renderer test',
          backend: { provider: 'openai', model: 'test', apiKey: 'offline' },
          prompt: { system: 'Test' },
          knowledge: {
            sources: [{ type, url: 'https://example.test/' }],
            embedding: { provider: 'openai', model: 'offline' },
            extract: { renderJs: true },
          },
        },
        { env: {} },
      )
      if (!config.ok) throw new Error(JSON.stringify(config.errors))
      const source = config.value.knowledge.sources[0]!
      const run =
        source.type === 'crawl'
          ? loadCrawl(source, config.value)
          : source.type === 'sitemap'
            ? loadSitemap(source, config.value)
            : Promise.resolve([])
      await expect(run).rejects.toThrow(
        /renderJs requires Playwright and Chromium.*playwright install chromium/,
      )
    },
  )
})
