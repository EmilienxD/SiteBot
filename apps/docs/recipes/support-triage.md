# Support triage

A first-line support assistant for signed-in customers. It looks up the customer's own orders, answers
what it can, opens a ticket when it can't, and hands off to a person when the customer asks or the
problem is urgent. Every call to your APIs carries the verified customer's identity, not an ID the model
typed.

## The config

```yaml [chatbot.config.yaml]
version: 1
name: Parcelwise Support
mode: agent

backend:
  provider: anthropic
  model: claude-sonnet-5
  fallback:
    - provider: openai
      model: gpt-5-mini

prompt:
  system: |
    You are first-line support for Parcelwise, a parcel delivery service.
    Look up the customer's orders before answering questions about them.
    Resolve what you can from the order data and the site facts. If you cannot,
    open a ticket with a clear summary. If the customer asks for a person, or a
    parcel is lost or damaged, hand off to a human.
  includePageContext: true

siteContext:
  company: Parcelwise
  description: Next-day parcel delivery across the Benelux.
  primaryUrl: https://parcelwise.example
  supportUrl: https://parcelwise.example/help
  facts:
    - Parcels are insured up to €500; claims must be made within 14 days.
    - Delivery can be redirected until 22:00 the evening before.

storage:
  type: postgres
  url: ${env.DATABASE_URL}

agent:
  maxSteps: 6
  approvalPolicy: always

security:
  allowedOrigins: [https://parcelwise.example]
  auth:
    mode: required
    jwt:
      algorithm: RS256
      jwksUrl: https://parcelwise.example/.well-known/jwks.json
      issuer: https://parcelwise.example
      audience: sitebot
  rateLimit:
    store: redis
    url: ${env.REDIS_URL}
  trustProxy: 1

tools:
  - name: list_my_orders
    description: |
      List the signed-in customer's recent orders with their status.
      Use before answering any question about a delivery.
    readOnly: true
    scope: authenticated
    executor:
      type: http
      url: https://api.parcelwise.example/customers/{{identity.sub}}/orders
      headers: { authorization: 'Bearer ${env.SUPPORT_API_TOKEN}' }
      allowHosts: [api.parcelwise.example]
      responsePath: $.orders

  - name: open_ticket
    description: |
      Open a support ticket for the signed-in customer.
      Use when you cannot resolve the problem from the order data.
    readOnly: false
    scope: authenticated
    requiresApproval: true
    approvalRisk: low
    approvalSummary: Open a support ticket with this summary. We reply by email within one working day.
    parameters:
      type: object
      properties:
        orderId: { type: string }
        category: { type: string, enum: [delay, damage, lost, address, other] }
        summary: { type: string, maxLength: 1000 }
      required: [category, summary]
    executor:
      type: http
      method: POST
      url: https://api.parcelwise.example/tickets
      headers:
        authorization: 'Bearer ${env.SUPPORT_API_TOKEN}'
        x-customer-id: '{{identity.sub}}'
      allowHosts: [api.parcelwise.example]
    maxCallsPerSession: 2

  - name: talk_to_a_person
    description: |
      Hand the conversation to a human agent.
      Use when the customer asks for a person, or a parcel is lost or damaged.
    readOnly: true
    executor:
      type: builtin
      id: handoff
      target:
        kind: zendesk
        url: https://parcelwise.zendesk.com/hc/en-us/requests/new
        includeTranscript: true
      message: A support agent will pick this up — usually within 15 minutes.

telemetry:
  events:
    webhook: ${env.SUPPORT_EVENTS_WEBHOOK}
    include: [handoff, error, feedback]

ui:
  messages:
    greeting: Hi! I can check your deliveries, open a ticket, or get you a person.
  footer:
    text: This chat is AI-assisted and may be reviewed by our support team.
    linkText: Privacy
    linkUrl: /privacy
```

## Identifying the customer

`auth.mode: required` means every chat request must carry a JWT your site issues for the signed-in
customer. The server verifies it against your JWKS before anything runs. Pass it to the widget after
sign-in:

```js
SiteBot.identify(await fetch('/api/sitebot-token').then((response) => response.text()))
```

## How it works

- **Identity comes from the token, not the model.** `{{identity.sub}}` in the URL and headers is filled
  from the verified JWT. The model can't choose which customer's orders to read, because there's no
  `customerId` parameter for it to fill.
- **Reads are free, writes are approved.** Listing orders runs without asking. Opening a ticket shows
  the summary on an approval card first, and `maxCallsPerSession` stops a loop from opening ten.
- **Handoff goes where your team works.** The handoff builtin opens the Zendesk messenger if it's on the
  page, or its request form otherwise. It also emits a `handoff` event, with the transcript, to your
  webhook, so the agent picking it up has the context.
- **It stays up when a provider doesn't.** `backend.fallback` switches to OpenAI if Anthropic fails.
  Sessions in Postgres and rate limits in Redis are shared by every replica.
