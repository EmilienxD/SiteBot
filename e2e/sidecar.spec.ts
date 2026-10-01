import { expect, test } from './fixtures.js'

/**
 * examples/express-sidecar in a browser: the page is on :4318, the widget
 * bundle and the chat API on :8787. Every request the widget makes is
 * cross-origin, so this is the test that `data-endpoint`, `data-key`, CORS
 * on the bundle and the API's origin allowlist all actually line up.
 */
test('the widget chats with a sidecar on another origin', async ({ page, widget }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const configRequest = page.waitForRequest('http://localhost:8787/api/chat/config**')
  await page.goto('http://localhost:4318/register/')
  await widget.open()
  expect((await configRequest).url()).toContain('key=pk_fernhill_demo')
  await expect(widget.panel).toContainText('Fernhill Dental')
  await widget.send('hi there')
  await expect(widget.lastAnswer()).toContainText('scripted model')
  expect(errors).toEqual([])
})
