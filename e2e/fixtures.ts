import { test as base, expect, type Locator, type Page } from '@playwright/test'

/**
 * The widget mounts into a *closed* shadow root, which no test runner can
 * pierce. Forcing it open before any page script runs changes nothing a
 * visitor can observe, and lets locators reach inside `<site-chat>`.
 */
const OPEN_SHADOW_ROOTS = `
  const attach = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (init) {
    return attach.call(this, { ...init, mode: 'open' })
  }
`

export class Widget {
  constructor(readonly page: Page) {}

  get host(): Locator {
    return this.page.locator('site-chat')
  }
  get launcher(): Locator {
    return this.host.getByRole('button', { name: 'Open chat assistant' })
  }
  get panel(): Locator {
    return this.host.getByRole('dialog', { name: 'Chat assistant' })
  }
  get input(): Locator {
    return this.panel.locator('.composer textarea')
  }
  get log(): Locator {
    return this.panel.getByRole('log')
  }
  get approval(): Locator {
    return this.panel.getByRole('alertdialog')
  }
  /** The last assistant bubble's text. */
  lastAnswer(): Locator {
    return this.log.locator('.message.assistant .bubble').last()
  }

  async open(): Promise<void> {
    await this.launcher.click()
    await expect(this.panel).toBeVisible()
  }
  async send(text: string): Promise<void> {
    await this.input.fill(text)
    await this.input.press('Enter')
  }
  /** Resolves when no response is streaming (the send button is back). */
  async idle(): Promise<void> {
    await expect(this.panel.getByRole('button', { name: 'Send message' })).toBeVisible()
  }
}

export const test = base.extend<{ widget: Widget }>({
  widget: async ({ page }, use) => {
    await page.addInitScript(OPEN_SHADOW_ROOTS)
    await use(new Widget(page))
  },
})

export { expect }
