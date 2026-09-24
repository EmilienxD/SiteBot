import { expect, test } from './fixtures.js'

// Focus lands on Deny (docs/07 §8), so a stray Enter declines rather than acts.
test('Enter on a fresh approval card declines, never approves', async ({ page, widget }) => {
  await page.goto('/wholesale')
  await widget.open()
  await widget.send('fill the form')
  await expect(widget.approval).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(widget.lastAnswer()).toContainText('left the page as it is')
  await expect(page.locator('[name=business]')).toHaveValue('')
})

test('two script tags make one widget and one warning, and nothing throws', async ({
  page,
  widget,
}) => {
  const errors: string[] = []
  const warnings: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text())
  })
  await page.goto('/')
  await page.addScriptTag({ url: '/sitebot.js?again', type: 'module' })
  await page.evaluate(() => {
    const tag = document.createElement('script')
    tag.type = 'module'
    tag.src = '/sitebot.js?third'
    tag.dataset.endpoint = '/api/chat'
    document.body.append(tag)
  })
  await page.waitForLoadState('networkidle')
  await expect(page.locator('site-chat')).toHaveCount(1)
  await widget.open()
  expect(errors).toEqual([])
  expect(warnings.filter((text) => /sitebot|site-chat/i.test(text)).length).toBeLessThanOrEqual(1)
})
