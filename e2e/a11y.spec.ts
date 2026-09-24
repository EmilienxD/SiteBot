import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test, type Widget } from './fixtures.js'

/**
 * axe-core over every widget state (docs/07 §8). Scoped to `<site-chat>`: the
 * example page's own markup is not the widget's to answer for.
 */
async function audit(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include('site-chat')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  const summary = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  )
  expect(summary, `axe violations in state "${state}"`).toEqual([])
}

const states: Record<string, (page: Page, widget: Widget) => Promise<void>> = {
  'launcher only': async () => {},
  'open, empty': async (_page, widget) => {
    await widget.open()
  },
  'answered, with feedback buttons': async (_page, widget) => {
    await widget.open()
    await widget.send('hi there')
    await widget.idle()
  },
  streaming: async (_page, widget) => {
    await widget.open()
    await widget.send('slow please')
    await expect(widget.lastAnswer()).toContainText('Word2')
  },
  'approval pending': async (page, widget) => {
    await page.goto('/wholesale')
    await widget.open()
    await widget.send('fill the form')
    await expect(widget.approval).toBeVisible()
  },
  'rate limited': async (page, widget) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 429,
        headers: { 'retry-after': '30' },
        json: { code: 'rate_limited' },
      }),
    )
    await widget.open()
    await widget.send('hello')
    await expect(widget.panel.locator('.retry-countdown')).toBeVisible()
  },
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme })
    for (const [state, reach] of Object.entries(states)) {
      test(state, async ({ page, widget }) => {
        await page.goto('/')
        await reach(page, widget)
        await audit(page, state)
      })
    }
  })
}

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('open sheet', async ({ page, widget }) => {
    await page.goto('/')
    await widget.open()
    await audit(page, 'mobile sheet')
  })
})
