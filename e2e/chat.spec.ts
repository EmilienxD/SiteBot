import { expect, test, OPEN_SHADOW_ROOTS, Widget } from './fixtures.js'

test.describe('rendering and streaming', () => {
  test('shows the greeting, then streams a markdown answer', async ({ page, widget }) => {
    await page.goto('/')
    await widget.open()
    await expect(widget.log).toContainText('Looking for a coffee')
    // docs/07 §8: the launcher names the dialog it controls.
    await expect(widget.launcher).toHaveAttribute('aria-controls', 'sitebot-panel')
    await expect(widget.panel).toHaveAttribute('id', 'sitebot-panel')
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

for (const scope of ['tab', 'browser'] as const) {
  test(`a new tab restores history only with sessionScope: ${scope}`, async ({ page, widget }) => {
    await page.context().route('**/api/chat/config*', async (route) => {
      const response = await route.fetch()
      const config = await response.json()
      config.ui.behaviour.sessionScope = scope
      await route.fulfill({ response, json: config })
    })
    await page.goto('/')
    await widget.open()
    const firstRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/chat'),
    )
    await widget.send('first tab')
    const firstSession = (await firstRequest).postDataJSON().sessionId
    await expect(widget.lastAnswer()).toContainText('first tab')

    const other = await page.context().newPage()
    await other.addInitScript(OPEN_SHADOW_ROOTS)
    await other.goto('/')
    const second = new Widget(other)
    await second.ensureOpen()
    if (scope === 'tab') await expect(second.log).not.toContainText('first tab')
    else await expect(second.log).toContainText('first tab')
    const secondRequest = other.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/chat'),
    )
    await second.send('second tab')
    expect((await secondRequest).postDataJSON().sessionId === firstSession).toBe(
      scope === 'browser',
    )
    await expect(second.lastAnswer()).toContainText('second tab')
    await other.close()
  })
}

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
    await expect(widget.input).toBeFocused()
    await expect(widget.log.locator('.tool-chip')).toContainText('Done')
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
    await expect(widget.log.locator('.tool-chip')).toContainText('Denied')
    await expect(widget.input).toBeFocused()
  })

  test('a pending approval survives a reload', async ({ page, widget }) => {
    await page.goto('/wholesale')
    await widget.open()
    for (let index = 0; index < 6; index += 1) {
      await widget.send(`Earlier question ${index}`)
      await expect(widget.lastAnswer()).toContainText(`Earlier question ${index}`)
    }
    await widget.send('fill the form')
    await expect(widget.approval).toBeVisible()
    await page.reload()
    await widget.ensureOpen()
    await expect(widget.approval).toBeVisible()
    await expect(widget.approval.getByRole('button', { name: 'Deny' })).toBeFocused()
    const buttons = (await widget.approval.locator('.card-actions').boundingBox())!
    const log = (await widget.log.boundingBox())!
    expect(buttons.y + buttons.height).toBeLessThanOrEqual(log.y + log.height)
    await widget.approval.getByRole('button', { name: 'Approve' }).click()
    await expect(page.locator('[name=business]')).toHaveValue('Bean Cafe')
    await expect(widget.lastAnswer()).toContainText('"filled":true')
  })

  test('navigate loads the page and the conversation carries over', async ({ page, widget }) => {
    await page.goto('/')
    await widget.open()
    await widget.send('please go to shop')
    await page.waitForURL('**/shop')
    await widget.ensureOpen()
    await expect(widget.log).toContainText('please go to shop')
  })
})
