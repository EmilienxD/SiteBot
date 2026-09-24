import { expect, test } from './fixtures.js'

test.describe('rendering and streaming', () => {
  test('shows the greeting, then streams a markdown answer', async ({ page, widget }) => {
    await page.goto('/')
    await widget.open()
    await expect(widget.log).toContainText('Looking for a coffee')
    await widget.send('hi there')
    await expect(widget.lastAnswer()).toContainText('You said: hi there')
    await expect(widget.lastAnswer().locator('strong')).toHaveText('Hello')
  })

  test('shows a stop button while streaming and stops on click', async ({ page, widget }) => {
    await page.goto('/')
    await widget.open()
    await widget.send('slow please')
    const stop = widget.panel.getByRole('button', { name: 'Stop response' })
    await expect(stop).toBeVisible()
    await expect(widget.lastAnswer()).toContainText('Word3')
    await stop.click()
    await widget.idle()
    await expect(widget.lastAnswer()).not.toContainText('Word40')
  })

  test('a suggestion chip sends its text', async ({ page, widget }) => {
    await page.goto('/')
    await widget.open()
    await widget.panel.getByRole('button', { name: 'Wholesale pricing' }).click()
    await expect(widget.lastAnswer()).toContainText('What does wholesale cost?')
  })
})

test.describe('client tools', () => {
  test('highlight scrolls to the element and outlines it', async ({ page, widget }) => {
    await page.goto('/')
    await widget.open()
    await widget.send('highlight #subscriptions')
    const target = page.locator('#subscriptions')
    await expect(target).toBeInViewport()
    await expect(target).toHaveCSS('outline-style', 'solid')
    await expect(widget.lastAnswer()).toContainText('"found":true')
  })

  test('approved fill_form fills the form, by option label, and never submits', async ({
    page,
    widget,
  }) => {
    let submitted = false
    page.on('request', (request) => {
      if (request.method() === 'POST' && !request.url().includes('/api/chat')) submitted = true
    })
    await page.goto('/wholesale')
    await widget.open()
    await widget.send('fill the form')
    await expect(widget.approval).toBeVisible()
    await widget.approval.getByRole('button', { name: 'Approve' }).click()
    await expect(widget.lastAnswer()).toContainText('"filled":true')
    await expect(page.locator('[name=business]')).toHaveValue('Bean Cafe')
    await expect(page.locator('[name=email]')).toHaveValue('owner@beancafe.com')
    await expect(page.locator('[name=volume]')).toHaveValue('5-20')
    expect(submitted).toBe(false)
  })

  test('fill_form reports a select value that is not an option', async ({ page, widget }) => {
    await page.goto('/wholesale')
    await widget.open()
    await widget.send('fill bad')
    await widget.approval.getByRole('button', { name: 'Approve' }).click()
    await expect(widget.lastAnswer()).toContainText('"filled":false')
    await expect(widget.lastAnswer()).toContainText('invalid_option')
    await expect(page.locator('[name=volume]')).toHaveValue('')
  })

  test('the model sees the form outline in page context', async ({ page, widget }) => {
    await page.goto('/wholesale')
    await widget.open()
    await widget.send('forms?')
    await expect(widget.lastAnswer()).toContainText('[Form #wholesale-form:')
    await expect(widget.lastAnswer()).toContainText('50+ "Over 50 kg"')
  })

  test('deny gets a polite answer, not an error', async ({ page, widget }) => {
    await page.goto('/wholesale')
    await widget.open()
    await widget.send('fill the form')
    await widget.approval.getByRole('button', { name: 'Deny' }).click()
    await expect(widget.lastAnswer()).toContainText('left the page as it is')
    await expect(widget.panel.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('[name=business]')).toHaveValue('')
  })

  test('a pending approval survives a reload', async ({ page, widget }) => {
    await page.goto('/wholesale')
    await widget.open()
    await widget.send('fill the form')
    await expect(widget.approval).toBeVisible()
    await page.reload()
    if (!(await widget.panel.isVisible())) await widget.open()
    await expect(widget.approval).toBeVisible()
    await widget.approval.getByRole('button', { name: 'Approve' }).click()
    await expect(page.locator('[name=business]')).toHaveValue('Bean Cafe')
  })

  test('navigate loads the page and the conversation carries over', async ({ page, widget }) => {
    await page.goto('/')
    await widget.open()
    await widget.send('please go to shop')
    await page.waitForURL('**/shop')
    if (!(await widget.panel.isVisible())) await widget.open()
    await expect(widget.log).toContainText('please go to shop')
  })
})
