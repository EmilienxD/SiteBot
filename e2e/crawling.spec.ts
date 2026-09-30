import { test, expect } from './fixtures.js'
// @ts-expect-error — fixture shared with the interactive browser check is plain JS.
import { startCrawlSite } from './fixtures/crawl-site.mjs'

test('rendered crawl indexes async content and links, enforces robots, and answers through the widget', async ({
  page,
  widget,
}, testInfo) => {
  const site = await startCrawlSite()
  try {
    await page.goto(`${site.baseUrl}/verify`)
    await page.getByRole('button', { name: 'Ingest JavaScript site' }).click()
    await expect(page.locator('#result')).toContainText('JAVASCRIPT-KNOWLEDGE', { timeout: 20_000 })
    await expect(page.locator('#result')).toContainText('DYNAMIC-LINK')
    await expect(page.locator('#result')).not.toContainText('ROBOTS-BLOCKED-SECRET')
    const crawlerRequests = site.state.requests.filter((r: { ua: string }) =>
      r.ua?.includes('sitebot-ingest'),
    )
    expect(crawlerRequests.some((r: { path: string }) => r.path.startsWith('/blocked'))).toBe(false)
    expect(crawlerRequests.filter((r: { path: string }) => r.path === '/robots.txt')).toHaveLength(
      1,
    )
    expect(crawlerRequests.filter((r: { path: string }) => r.path === '/data')).toHaveLength(2)
    await widget.open()
    await widget.send('call search_knowledge_base {"query":"delivery"}')
    await expect(widget.lastAnswer()).toContainText('Aurora deliveries arrive in seven days.')
    await expect(widget.lastAnswer()).not.toContainText('ROBOTS-BLOCKED-SECRET')
    await page.screenshot({ path: testInfo.outputPath('crawl-to-widget.png'), fullPage: true })

    // The HTML shell and its ETag remain unchanged; API content changes.
    site.state.content = 'JAVASCRIPT-KNOWLEDGE: Aurora deliveries now arrive in two days.'
    await page.getByRole('button', { name: 'Ingest JavaScript site' }).click()
    await expect(page.locator('#result')).toContainText('now arrive in two days.', {
      timeout: 20_000,
    })
    await expect(page.locator('#result')).not.toContainText('arrive in seven days.')
  } finally {
    await site.close()
  }
})

test('sitemap uses real JavaScript rendering; disabling rendering retains the static HTML path', async ({
  request,
}) => {
  const site = await startCrawlSite()
  try {
    const staticRun = await request.post(`${site.baseUrl}/ingest`, {
      data: { type: 'sitemap', renderJs: false },
    })
    expect(staticRun.ok()).toBe(true)
    expect((await staticRun.json()).report.index.documents).toBe(0)
    const renderedRun = await request.post(`${site.baseUrl}/ingest`, {
      data: { type: 'sitemap', renderJs: true },
    })
    expect(renderedRun.ok()).toBe(true)
    const result = await renderedRun.json()
    expect(result.report.index.documents).toBe(1)
    expect(result.text).toContain('JAVASCRIPT-KNOWLEDGE')
    expect(result.text).not.toContain('ROBOTS-BLOCKED-SECRET')
  } finally {
    await site.close()
  }
})

test('robots opt-out applies to rendered crawls and rendering failures preserve the previous index', async ({
  request,
}) => {
  const site = await startCrawlSite()
  try {
    const first = await request.post(`${site.baseUrl}/ingest`, {
      data: { renderJs: true, respectRobots: false },
    })
    expect(first.ok()).toBe(true)
    const indexed = await first.json()
    expect(indexed.text).toContain('ROBOTS-BLOCKED-SECRET')
    const crawlerRequests = site.state.requests.filter((r: { ua: string }) =>
      r.ua?.includes('sitebot-ingest'),
    )
    expect(crawlerRequests.some((r: { path: string }) => r.path === '/robots.txt')).toBe(false)
    expect(crawlerRequests.some((r: { path: string }) => r.path === '/blocked-api')).toBe(true)
    const before = await site.store.stats()
    site.state.failApi = true
    const failed = await request.post(`${site.baseUrl}/ingest`, {
      data: { renderJs: true, respectRobots: false },
    })
    expect(failed.status()).toBe(500)
    expect((await failed.json()).error).toContain('JavaScript rendering failed')
    expect(await site.store.stats()).toEqual(before)
  } finally {
    await site.close()
  }
})
