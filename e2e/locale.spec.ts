import { expect, test } from './fixtures.js'

test.use({ locale: 'en-US' })

for (const isolation of ['shadow', 'iframe'] as const) {
  test(`${isolation}: a French host controls labels and request locale through language changes`, async ({
    page,
    widget,
  }) => {
    await page.route('**/api/chat/config*', async (route) => {
      const response = await route.fetch()
      const config = await response.json()
      config.ui.locale = 'auto'
      config.ui.isolation = isolation
      config.ui.strings = { fr: { send: 'Envoyer' } }
      config.ui.translations = { fr: { messages: { placeholder: 'Votre question…' } } }
      await route.fulfill({ response, json: config })
    })
    await page.goto('/')
    // Match the reported production case: English browser, French host page.
    await page.evaluate(() => {
      document.documentElement.lang = 'fr'
    })
    const host = widget.host
    await host.getByRole('button', { name: 'Ouvrir l’assistant de discussion' }).click()
    const panel =
      isolation === 'iframe'
        ? host.frameLocator('iframe').locator('.panel')
        : host.locator('.panel')
    await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeVisible()
    await expect(panel.locator('textarea')).toHaveAttribute('placeholder', 'Votre question…')
    const firstRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/chat'),
    )
    await panel.locator('textarea').fill('Bonjour')
    await panel.locator('textarea').press('Enter')
    const first = await firstRequest
    expect(first.postDataJSON().locale).toBe('fr')
    expect(first.postDataJSON().pageContext.locale).toBe('fr')
    expect(first.headers()['accept-language']).toBe('fr')
    await expect(panel.locator('.message.assistant .bubble').last()).toContainText(
      'You said: Bonjour',
    )
    await page.evaluate(() => {
      document.documentElement.lang = 'en'
    })
    await expect(panel.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
    await expect(panel.getByRole('log')).toContainText('Bonjour')
    const secondRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/chat'),
    )
    await panel.locator('textarea').fill('Hello again')
    await panel.locator('textarea').press('Enter')
    const second = await secondRequest
    expect(second.postDataJSON().locale).toBe('en')
    expect(second.postDataJSON().sessionId).toBe(first.postDataJSON().sessionId)
    await expect(panel.locator('.message.assistant .bubble').last()).toContainText('Hello again')
    await page.evaluate(() =>
      (window as unknown as { SiteBot: { setLocale(locale: string): void } }).SiteBot.setLocale(
        'fr-CA',
      ),
    )
    await expect(panel.getByRole('button', { name: 'Envoyer', exact: true })).toBeVisible()
    await expect(panel.getByRole('log')).toContainText('Bonjour')
    if (isolation === 'iframe')
      await expect(host.frameLocator('iframe').locator('html')).toHaveAttribute('lang', 'fr')
  })
}
