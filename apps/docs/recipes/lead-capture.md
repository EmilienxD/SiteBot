# Lead-capture bot

A sales assistant that answers pre-sales questions, then helps the visitor fill in the contact form on
the page. It never submits the form: the visitor reviews the filled fields and presses Send. Each lead
is also sent to your own webhook, so sales sees it straight away.

## The config

```yaml [chatbot.config.yaml]
version: 1
name: Brightline Analytics
mode: agent

backend:
  provider: anthropic
  model: claude-sonnet-5

prompt:
  system: |
    You are the sales assistant on Brightline Analytics' website. Answer questions
    about plans and features from the site facts and the page. When a visitor
    wants a demo or a quote, collect their name, work email, company and team
    size, then offer to fill in the contact form for them.
    Only fill fields the visitor has actually told you. Never guess an email.
  includePageContext: true

siteContext:
  company: Brightline Analytics
  description: Product analytics for B2B SaaS teams.
  primaryUrl: https://brightline.example
  facts:
    - Plans are Starter (€49/month), Growth (€299/month) and Enterprise (custom).
    - Every plan has a 14-day free trial; no card needed.
    - Demos are 30 minutes, with a solutions engineer.
  routes:
    - path: /pricing
      summary: Plans, limits and what each includes.
    - path: /contact
      summary: The demo and quote request form.

storage:
  type: sqlite
  path: ./.sitebot/sessions.db

agent:
  maxSteps: 4
  approvalPolicy: always

tools:
  - name: go_to_contact
    description: |
      Take the visitor to the contact form.
      Use when they want a demo or a quote and are not on /contact yet.
    readOnly: true
    parameters:
      type: object
      properties:
        path: { type: string, enum: [/contact] }
      required: [path]
    executor: { type: builtin, id: navigate }

  - name: fill_contact_form
    description: |
      Prefill the contact form on /contact with what the visitor told you.
      Use when the visitor is on /contact and has given their details.
      The page context lists the form's fields and the valid options for each select.
    readOnly: false
    requiresApproval: true
    approvalRisk: low
    approvalSummary: Fill in the contact form with the details you gave. Nothing is sent until you press Send.
    parameters:
      type: object
      properties:
        selector: { type: string, description: 'Always "#contact-form".' }
        fields:
          type: object
          description: 'Field values keyed by input name: name, email, company, team_size, message.'
      required: [selector, fields]
    executor: { type: client, id: fill_form }

  - name: record_lead
    description: |
      Record a qualified lead for the sales team.
      Use once, after the visitor has given at least a name and a work email.
    readOnly: false
    requiresApproval: true
    approvalSummary: Share your contact details with Brightline's sales team.
    parameters:
      type: object
      properties:
        name: { type: string }
        email: { type: string, format: email }
        company: { type: string }
        teamSize: { type: string }
      required: [name, email]
    executor: { type: builtin, id: collect_lead }

telemetry:
  events:
    webhook: ${env.LEADS_WEBHOOK_URL}
    include: [lead, handoff, error]

security:
  allowedOrigins: [https://brightline.example]

ui:
  messages:
    greeting: Hi! Questions about plans, or want to book a demo?
  footer:
    text: This chat is AI-assisted. Details you share are sent to our sales team.
    linkText: Privacy
    linkUrl: /privacy
```

## How it works

- **The form stays the visitor's.** `fill_form` sets values and never submits. Every field is read
  back: a select given a value it doesn't have is reported as rejected, with the valid options, rather
  than silently left blank. The model then asks the visitor instead of claiming the form is done.
- **The model knows the form.** On `/contact`, page context includes an outline of `#contact-form`: field
  names, types and select options. So `team_size` gets `11-50`, not "about thirty".
- **Two approvals, both explicit.** Filling the form and sharing details with sales are separate tools,
  each with its own approval card. A visitor can let the form be filled and still decline to be
  recorded as a lead.
- **Leads go to your webhook.** `collect_lead` emits a `lead` event. With `telemetry.events.webhook`
  set, it's POSTed to your endpoint (Slack, Zapier, your CRM), and nothing else is sent anywhere.
- **The footer says what happens.** Shared details reach a person, so the notice says so.
