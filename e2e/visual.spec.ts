import { expect, test } from './fixtures.js'

/**
 * Visual snapshots: 4 viewports × 2 themes (docs/07 §11), of the panel with a
 * short conversation in it. Baselines are per platform — font rasterisation
 * differs between Linux CI and a Windows or macOS laptop — so CI compares
 * against the `-linux` files. Regenerate with `pnpm e2e:update-snapshots`.
 */
const viewports = {
  'mobile-s': { width: 360, height: 740 },
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
} as const

for (const [name, viewport] of Object.entries(viewports)) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${name} ${scheme}`, () => {
      test.use({ viewport, colorScheme: scheme, reducedMotion: 'reduce' })

      test('panel with a conversation', async ({ page, widget }) => {
        await page.goto('/')
        await widget.open()
        await widget.send('hi there')
        await widget.idle()
        // The composer caret blinks; the snapshot is of layout, not focus.
        await widget.input.blur()
        await expect(widget.panel).toHaveScreenshot(`panel-${name}-${scheme}.png`)
      })
    })
  }
}

// docs/07 §11 "Isolation": a host stylesheet at its most hostile must not move
// a pixel — the same baseline as the clean desktop render above.
test.describe('hostile host CSS', () => {
  test.use({ viewport: viewports.desktop, colorScheme: 'light', reducedMotion: 'reduce' })

  test('leaves the panel pixel-identical', async ({ page, widget }) => {
    await page.goto('/')
    await page.addStyleTag({
      content: `
        * { color: red !important; font: 30px/3 serif !important; box-sizing: content-box !important;
            margin: 7px !important; letter-spacing: 3px !important; }
        button, textarea { all: revert !important; background: lime !important; }
        site-chat { filter: none; font-size: 40px; line-height: 4; color: red; direction: ltr; }
        html { font-size: 30px !important; }
      `,
    })
    await widget.open()
    await widget.send('hi there')
    await widget.idle()
    await widget.input.blur()
    await expect(widget.panel).toHaveScreenshot('panel-desktop-light.png')
  })
})
