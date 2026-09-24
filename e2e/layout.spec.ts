import { expect, test } from './fixtures.js'

test.describe('mobile (≤ 480 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('opens full-screen with a back chevron, locks scroll and traps focus', async ({
    page,
    widget,
  }) => {
    await page.goto('/')
    await widget.open()
    // Polled: the open animation scales the sheet in from slightly smaller.
    await expect
      .poll(() => widget.panel.boundingBox())
      .toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')

    // Tab through more stops than the panel has: focus must never leave it.
    for (let step = 0; step < 15; step += 1) {
      await page.keyboard.press('Tab')
      const inside = await widget.host.evaluate((host) => host.shadowRoot?.activeElement !== null)
      expect(inside, `focus escaped the panel after ${step + 1} tabs`).toBe(true)
    }

    await widget.panel.getByRole('button', { name: 'Back' }).click()
    await expect(widget.panel).toBeHidden()
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
  })
})

test.describe('desktop', () => {
  test('the wheel scrolls the message list, not the page', async ({ page, widget }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    await page.goto('/')
    await widget.open()
    for (let turn = 1; turn <= 6; turn += 1) {
      await widget.send(`message number ${turn}`)
      await expect(widget.lastAnswer()).toContainText(`message number ${turn}`)
    }
    const list = widget.panel.locator('.messages')
    const before = await list.evaluate((node) => node.scrollTop)
    expect(before, 'the list should have overflowed and followed to the bottom').toBeGreaterThan(0)
    const scrollY = await page.evaluate(() => window.scrollY)
    const box = (await list.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -300)
    await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeLessThan(before)
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY)
  })

  test('follows the OS dark theme in auto mode', async ({ page, widget }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await widget.open()
    const background = await widget.panel.evaluate((node) => getComputedStyle(node).backgroundColor)
    const [r = 255, g = 255, b = 255] = (background.match(/\d+/g) ?? []).map(Number)
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b, `panel background ${background}`).toBeLessThan(80)
  })

  test('the 429 countdown disables the composer, then re-enables it', async ({ page, widget }) => {
    await page.route('**/api/chat', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '2' },
            body: JSON.stringify({ code: 'rate_limited', message: 'Too many requests' }),
          })
        : route.fallback(),
    )
    await page.goto('/')
    await widget.open()
    await widget.send('hello')
    await expect(widget.panel.locator('.retry-countdown')).toHaveText(/Retry in [12]s/)
    await expect(widget.input).toBeDisabled()
    await expect(widget.panel.locator('.retry-countdown')).toBeHidden({ timeout: 5000 })
    await expect(widget.input).toBeEnabled()
  })

  test('feedback reaches the server', async ({ page, widget }) => {
    await page.goto('/')
    await widget.open()
    await widget.send('hello')
    await widget.idle()
    const feedback = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/chat/feedback') && response.request().method() === 'POST',
    )
    await widget.panel.getByRole('button', { name: 'Helpful', exact: true }).last().click()
    const response = await feedback
    expect(response.status()).toBeLessThan(300)
    expect(response.request().postDataJSON()).toMatchObject({ rating: 'up' })
  })
})

test.describe('iframe isolation', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/chat/config**', async (route) => {
      const response = await route.fetch()
      const config = await response.json()
      config.ui.isolation = 'iframe'
      await route.fulfill({ response, json: config })
    })
  })

  test('renders the panel in a frame, and highlight still scrolls the host page', async ({
    page,
    widget,
  }) => {
    await page.goto('/')
    await widget.launcher.click()
    const frame = widget.host.locator('iframe').contentFrame()
    const panel = frame.getByRole('dialog', { name: 'Chat assistant' })
    await expect(panel).toBeVisible()
    await panel.locator('.composer textarea').fill('highlight #subscriptions')
    await panel.locator('.composer textarea').press('Enter')
    await expect(page.locator('#subscriptions')).toBeInViewport()
    await expect(panel.locator('.message.assistant .bubble').last()).toContainText('"found":true')
  })
})
