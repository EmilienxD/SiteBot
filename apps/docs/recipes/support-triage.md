# Support assistant

The consuming application owns this tool, its data access, and its service implementation. Replace the example endpoint or module with your application implementation. SiteBot validates the schemas, permissions, deadline and result.

```yaml [chatbot.config.yaml]
version: 1
name: Support assistant
mode: agent
backend:
  provider: openai
  model: gpt-5-mini
prompt:
  system: Ask for a concise issue summary and confirm before creating a support request.
ui:
  locale: auto
  supportedLocales: [en, fr]
tools:
  - name: create_support_request
    description: Create a support request using the application service after visitor approval.
    readOnly: false
    scope: public
    requiresApproval: true
    timeoutMs: 5000
    parameters:
      type: object
      properties: { summary: { type: string, minLength: 1, maxLength: 2000 } }
      required: [summary]
      additionalProperties: false
    outputSchema:
      type: object
      properties: { ticketId: { type: string } }
      required: [ticketId]
      additionalProperties: false
    executor:
      type: http
      method: POST
      url: https://api.example.com/support
      allowHosts: [api.example.com]
```
