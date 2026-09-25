import { expect, test } from './fixtures.js'

/**
 * docs/07 §11 rows that need a page of their own: an SPA whose route changes
 * never reload, and a network drop in the middle of a conversation.
 */

// A tiny client-side router: two views, pushState, and the one line docs/03
// §9 asks an SPA to add.
const SPA = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>SPA fixture</title></head>
  <body>
    <nav><a href="/spa" data-route="home">Home</a> <a href="/spa/pricing" data-route="pricing">Pricing</a></nav>
    <main id="view"><h1>Home</h1><p>PAGE-MARKER-HOME Welcome to the app.</p></main>
    <script>
      const views = {
        home: '<h1>Home</h1><p>PAGE-MARKER-HOME Welcome to the app.</p>',
        pricing: '<h1>Pricing</h1><p>PAGE-MARKER-PRICING Plans start at ten euros.</p>',
      }
      document.querySelectorAll('[data-route]').forEach((link) =>
        link.addEventListener('click', (event) => {
          event.preventDefault()
          history.pushState({}, '', link.getAttribute('href'))
          document.getElementById('view').innerHTML = views[link.dataset.route]
          window.SiteBot.refreshPageContext()
        }),
      )
    </script>
    <script type="module" src="/sitebot.js" data-endpoint="/api/chat"></script>
  </body>
</html>`

test('an SPA route change plus refreshPageContext() sends the new page (docs/03 §9)', async ({
  page,
  widget,
}) => {
  await page.route('**/spa**', (route) =>
    route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: SPA })
      : route.fallback(),
  )
  await page.goto('/spa')
  await widget.open()
  await widget.send('markers?')
  await expect(widget.lastAnswer()).toHaveText('PAGE-MARKER-HOME')

  await page.getByRole('link', { name: 'Pricing' }).click()
  await expect(page).toHaveURL(/\/spa\/pricing$/)
  await widget.send('markers? again')
  await expect(widget.lastAnswer()).toHaveText('PAGE-MARKER-PRICING')
})

test('a dropped connection is retried once, silently, and the answer arrives (docs/03 §11)', async ({
  page,
  widget,
}) => {
  let posts = 0
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts += 1
    if (posts === 1) return route.abort('connectionreset')
    return route.fallback()
  })
  await page.goto('/')
  await widget.open()
  await widget.send('hi after a drop')
  await expect(widget.lastAnswer()).toContainText('You said: hi after a drop')
  expect(posts).toBe(2)
  await expect(widget.panel.getByRole('alert')).toHaveCount(0)
  // One user turn, not two: the retry resends the same message.
  await expect(widget.log.locator('.message.user')).toHaveCount(1)
})
