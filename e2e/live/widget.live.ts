import { expect, test } from '../fixtures.js'

/**
 * The README's "What to try" table, run for real: the plain-html example,
 * served by the CLI, in a real browser, answered by a real model.
 *
 * Assertions check what the page and protocol do, never exact wording. The
 * system prompt keeps answers short, so a fact the model can only have read
 * from the page, or a DOM change only a tool call can make, is the evidence.
 */

test.skip(process.env['SITEBOT_LIVE_BROWSER_SKIP'] === '1', 'no live provider configured')

test('answers from the live page context', async ({ page, widget }) => {
  await page.goto('/shop')
  await widget.open()
  await widget.send('How much is a bag of the Ethiopia Yirgacheffe?')
  await widget.idle()
  // $21 appears only on the shop page, not in siteContext.
  await expect(widget.lastAnswer()).toContainText('21')
  await expect(widget.panel.getByRole('alert')).toHaveCount(0)
})

test('navigates to another page and the conversation carries over', async ({ page, widget }) => {
  await page.goto('/')
  await widget.open()
  await widget.send('Take me to the shop page.')
  await page.getByRole('link', { name: 'Shop', exact: true }).click()
  await page.waitForURL('**/shop')
  await widget.ensureOpen()
  await expect(widget.log.locator('.message.user')).toContainText('Take me to the shop page.')
})

test('highlights a section of the current page', async ({ page, widget }) => {
  await page.goto('/brewing')
  // The outline is removed after 1.8 s; record that it was ever applied.
  await page.evaluate(() => {
    const target = document.querySelector('#storage')!
    const seen: string[] = ((window as unknown as { outlined: string[] }).outlined = [])
    new MutationObserver(() => {
      if ((target as HTMLElement).style.outline !== '') seen.push('#storage')
    }).observe(target, { attributes: true, attributeFilter: ['style'] })
  })
  await widget.open()
  await widget.send('Where on this page do you explain how to store beans? Show me.')
  await widget.idle()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { outlined: string[] }).outlined.length))
    .toBeGreaterThan(0)
  await expect(page.locator('#storage')).toBeInViewport()
})

test('fills the wholesale form only after approval, and never submits it', async ({
  page,
  widget,
}) => {
  let submitted = false
  page.on('request', (request) => {
    if (!request.url().includes('/api/chat') && request.url().includes('/wholesale?'))
      submitted = true
  })
  await page.goto('/wholesale')
  await widget.open()
  await widget.send(
    'Fill the wholesale form for Tidewater Cafe, email orders@tidewater.example, about 30 kg a month.',
  )
  await expect(widget.approval).toBeVisible()
  // docs/07 §8: the approval card takes focus on Deny, never Approve.
  await expect(widget.approval.getByRole('button', { name: 'Deny' })).toBeFocused()
  await expect(page.locator('[name=business]')).toHaveValue('')

  await widget.approval.getByRole('button', { name: 'Approve' }).click()
  await expect(page.locator('[name=business]')).toHaveValue(/Tidewater/i)
  await expect(page.locator('[name=email]')).toHaveValue('orders@tidewater.example')
  await expect(page.locator('[name=volume]')).toHaveValue('20-50')
  await widget.idle()
  expect(submitted).toBe(false)
  expect(new URL(page.url()).search).toBe('')
})

test('Enter on the approval card denies, and the model replies', async ({ page, widget }) => {
  await page.goto('/wholesale')
  await widget.open()
  await widget.send('Please fill the wholesale form for Tidewater Cafe, orders@tidewater.example.')
  await expect(widget.approval).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(widget.approval).toBeHidden()
  await widget.idle()
  await expect(page.locator('[name=business]')).toHaveValue('')
  await expect(widget.lastAnswer()).not.toBeEmpty()
  await expect(widget.panel.getByRole('alert')).toHaveCount(0)
})
