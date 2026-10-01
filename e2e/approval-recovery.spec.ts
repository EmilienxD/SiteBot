import { expect, test } from './fixtures.js'

const origin = 'http://127.0.0.1:4320'

for (const recovery of ['new message', 'Retry'] as const) {
  test(`an expired approval recovers through ${recovery}`, async ({ page, widget }) => {
    await page.goto(`${origin}/wholesale`)
    await widget.open()
    const request = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/chat'),
    )
    await widget.send('fill the form')
    const sessionId = (await request).postDataJSON().sessionId
    await expect(widget.approval).toBeVisible()
    const expired = await page.request.post(`${origin}/__test__/expire`, { data: { sessionId } })
    expect(expired.status()).toBe(204)
    await widget.approval.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(widget.panel.getByRole('alert')).toContainText('This request timed out')
    await expect(widget.log.locator('.tool-chip')).toContainText('Timed out')
    await expect(widget.log.locator('.spinner')).toHaveCount(0)
    await expect(widget.approval).toHaveCount(0)
    await expect(page.locator('[name=business]')).toHaveValue('')
    await expect(widget.input).toBeFocused()
    if (recovery === 'Retry') {
      await widget.panel.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(widget.lastAnswer()).toContainText('this action did not run')
      await widget.send('fill the form again')
      await expect(widget.approval).toBeVisible()
      await widget.approval.getByRole('button', { name: 'Deny', exact: true }).click()
      await expect(widget.lastAnswer()).toContainText('left the page as it is')
    } else {
      await widget.send('opening hours?')
      await expect(widget.lastAnswer()).toContainText('opening hours?')
    }
    await widget.send('thanks')
    await expect(widget.lastAnswer()).toContainText('thanks')
    await expect(widget.panel.getByRole('alert')).toHaveCount(0)
  })
}

test('a reload settles a cached expired card and leaves the composer usable', async ({
  page,
  widget,
}) => {
  await page.goto(`${origin}/wholesale`)
  await widget.open()
  const request = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/chat'),
  )
  await widget.send('fill the form')
  const sessionId = (await request).postDataJSON().sessionId
  await expect(widget.approval).toBeVisible()
  expect(
    (await page.request.post(`${origin}/__test__/expire`, { data: { sessionId } })).status(),
  ).toBe(204)
  await page.reload()
  await widget.ensureOpen()
  await expect(widget.approval).toHaveCount(0)
  await expect(widget.log.locator('.tool-chip')).toContainText('Timed out')
  await expect(widget.input).toBeFocused()
  await widget.send('hello after reload')
  await expect(widget.lastAnswer()).toContainText('hello after reload')
})

test('maxSteps bounds the full loop across browser tool calls', async ({ page, widget }) => {
  let modelRequests = 0
  let highlights = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/chat')) modelRequests += 1
  })
  await page.goto('/')
  await widget.open()
  await page.evaluate(() => {
    const api = (
      window as unknown as {
        SiteBot: {
          on: (event: string, handler: (data: { name: string; phase: string }) => void) => void
        }
      }
    ).SiteBot
    ;(window as unknown as { highlightCount: number }).highlightCount = 0
    api.on('tool', (data) => {
      if (data.name === 'highlight_section' && data.phase === 'call')
        (window as unknown as { highlightCount: number }).highlightCount += 1
    })
  })
  await widget.send('loop highlights')
  await expect(widget.lastAnswer()).toContainText('within the run limit')
  highlights = await page.evaluate(
    () => (window as unknown as { highlightCount: number }).highlightCount,
  )
  expect(highlights).toBe(4)
  expect(modelRequests).toBe(5)
  await expect(widget.log.locator('.spinner')).toHaveCount(0)
})
