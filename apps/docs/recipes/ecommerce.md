# Order assistant

The consuming application owns this tool, its data access, and its service implementation. Replace the example endpoint or module with your application implementation. SiteBot validates the schemas, permissions, deadline and result.

```yaml [chatbot.config.yaml]
version: 1
name: Order assistant
mode: chat
backend:
  provider: openai
  model: gpt-5-mini
prompt:
  system: Help customers using the application order-status tool.
ui:
  locale: auto
  supportedLocales: [en, fr]
security:
  auth:
    mode: required
    jwt: { secret: '${env.SITEBOT_JWT_SECRET}' }
tools:
  - name: read_order_status
    description: Read delivery status for an order owned by the signed-in visitor.
    readOnly: true
    scope: authenticated
    requiresApproval: false
    timeoutMs: 5000
    parameters:
      type: object
      properties: { orderId: { type: string, minLength: 1 } }
      required: [orderId]
      additionalProperties: false
    outputSchema:
      type: object
      properties: { status: { type: string } }
      required: [status]
      additionalProperties: false
    executor:
      type: http
      url: https://api.example.com/orders/{orderId}/status
      headers: { X-Acting-User: '{{identity.sub}}' }
      allowHosts: [api.example.com]
```
