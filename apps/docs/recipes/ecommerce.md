# Ecommerce assistant

A shopping assistant that knows the catalogue, checks stock, reads the visitor's cart and adds to it,
but only after the visitor approves each change. The cart stays entirely in your site's code; the
assistant calls it through client tools you register on the page.

## The config

```yaml [chatbot.config.yaml]
version: 1
name: Northstar Outdoor
mode: agent

backend:
  provider: anthropic
  model: claude-sonnet-5

prompt:
  system: |
    You are the shopping assistant on Northstar Outdoor, an outdoor-gear shop.
    Help visitors choose gear, compare products and manage their cart.
    Only recommend products that appear in the knowledge base or on the page.
    Before adding to the cart, confirm the size and colour with the visitor.
  includePageContext: true

siteContext:
  company: Northstar Outdoor
  description: Tents, sleeping bags and clothing for hiking and camping.
  primaryUrl: https://northstar.example
  facts:
    - Free delivery over €60; otherwise €4.95.
    - Returns are free within 60 days, unworn and with tags.
  routes:
    - path: /tents
      summary: All tents, by capacity and season.
    - path: /cart
      summary: The visitor's cart and checkout.

storage:
  type: redis
  url: ${env.REDIS_URL}

agent:
  maxSteps: 5
  approvalPolicy: always

knowledge:
  sources:
    - type: sitemap
      url: https://northstar.example/sitemap.xml
      include: ['/products/**', '/guides/**']
      exclude: ['/account/**', '/cart/**']
  embedding:
    provider: openai
    model: text-embedding-3-small
  store:
    type: pgvector
    url: ${env.DATABASE_URL}

tools:
  - name: check_stock
    description: |
      Check live stock for a product variant.
      Use when a visitor asks whether something is available in a size or colour.
    readOnly: true
    parameters:
      type: object
      properties:
        sku: { type: string, description: 'The product SKU, e.g. NS-TENT-2P.' }
      required: [sku]
    executor:
      type: http
      url: https://api.northstar.example/stock/{sku}
      headers: { authorization: 'Bearer ${env.STOCK_API_TOKEN}' }
      allowHosts: [api.northstar.example]
      responsePath: $.variants

  - name: get_cart
    description: |
      Read the items in the visitor's cart.
      Use when the visitor asks about their cart or before suggesting additions.
    readOnly: true
    executor: { type: client, id: get_cart }

  - name: add_to_cart
    description: |
      Add a product variant to the visitor's cart.
      Use when the visitor asks to add something and has confirmed size and colour.
    readOnly: false
    requiresApproval: true
    approvalRisk: low
    approvalSummary: Add this item to your cart. Nothing is charged.
    parameters:
      type: object
      properties:
        sku: { type: string }
        quantity: { type: integer, minimum: 1, maximum: 10 }
      required: [sku, quantity]
    executor: { type: client, id: add_to_cart }
    maxCallsPerSession: 10

security:
  allowedOrigins: [https://northstar.example]

ui:
  footer:
    text: Answers are AI-generated — check prices and sizes before you buy.
    linkText: Privacy
    linkUrl: /privacy
```

## The site-side code

Client tools run in the visitor's browser, against your own cart code. Register them once, after the
widget script:

```js
SiteBot.registerTool('get_cart', () => ({
  items: store.cart.items.map((item) => ({ sku: item.sku, quantity: item.quantity })),
  total: store.cart.total,
}))

SiteBot.registerTool('add_to_cart', async ({ sku, quantity }) => {
  await store.cart.add(sku, quantity)
  return { added: true, cartCount: store.cart.items.length }
})
```

## How it works

- **Product answers come from the knowledge base.** `pnpm sitebot ingest` indexes product and guide
  pages from the sitemap; `exclude` keeps account and cart pages out. The prompt tells the model to
  recommend only indexed products, and the page context covers the product being viewed.
- **Stock is live.** `check_stock` is a server-side HTTP tool, so the stock API token never reaches the
  browser, and `allowHosts` bounds where the templated URL can point.
- **The cart never leaves your code.** `get_cart` and `add_to_cart` are client tools. The server only
  sees their results, and only tools the config declares can be called.
- **Changes need a click.** `add_to_cart` isn't `readOnly`, so the visitor sees an approval card with
  the summary and the exact item before anything happens. `maxCallsPerSession` caps how many adds one
  conversation can make.
- **Agent mode persists state.** Approvals survive a reload because sessions are in Redis.
