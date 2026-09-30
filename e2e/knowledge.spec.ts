import { expect, test } from './fixtures.js'

test('semantic ingest → reranking → provider cache breakpoints → streamed citations', async ({
  page,
  widget,
  request,
}) => {
  await page.goto('http://127.0.0.1:4319')
  await widget.open()
  await widget.send('What is the returns policy?')
  await expect(widget.lastAnswer()).toContainText('30 days')
  await widget.idle()
  const citation = widget.panel.getByRole('button', { name: 'Source 1: policies' })
  await expect(citation).toBeVisible()
  const popupPromise = page.waitForEvent('popup')
  await citation.click()
  const popup = await popupPromise
  await expect(popup).toHaveURL('http://127.0.0.1:4319/docs/policies.md')
  await popup.close()
  await widget.send('Can I get a full refund?')
  await expect(widget.lastAnswer()).toContainText('full refund')
  await widget.idle()
  const evidence = await (await request.get('http://127.0.0.1:4319/evidence')).json()
  expect(evidence.chunks).toHaveLength(2)
  expect(evidence.chunks[0].text).toContain('Shipping')
  expect(evidence.chunks[0].text).not.toContain('Returns')
  expect(evidence.chunks[1].text).toContain('Returns')
  expect(evidence.chunks.every((chunk: { tokens: number }) => chunk.tokens <= 80)).toBe(true)
  expect(evidence.unchangedEmbeddingCalls).toBe(0)
  expect(evidence.reranks.at(-1).documents).toHaveLength(2)
  const last = evidence.messages.at(-1).system
  expect(last[0].cache_control).toEqual({ type: 'ephemeral' })
  expect(last[1].cache_control).toEqual({ type: 'ephemeral' })
  expect(last[2].cache_control).toBeUndefined()
  expect(last[2].text).toContain('Returns')
  expect(last[2].text).not.toContain('Shipping orders')
  const previous = evidence.messages.find(
    (entry: { messages: { role: string; content: { text?: string }[] }[] }) =>
      JSON.stringify(entry.messages).includes('What is the returns policy?'),
  ).system
  expect(last.slice(0, 2)).toEqual(previous.slice(0, 2))
  expect(last[2].text).not.toEqual(previous[2].text)
})
