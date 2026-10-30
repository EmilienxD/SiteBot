# Contact assistant

The consuming application owns this tool, its data access, and its service implementation. Replace the example endpoint or module with your application implementation. SiteBot validates the schemas, permissions, deadline and result.

```yaml [chatbot.config.yaml]
version: 1
name: Contact assistant
mode: agent
backend:
  provider: openai
  model: gpt-5-mini
prompt:
  system: Help visitors contact the team. Confirm before submitting their details.
ui:
  locale: auto
  supportedLocales: [en, fr]
tools:
  - name: request_contact
    description: Send the visitor contact details to the application after explicit approval.
    readOnly: false
    scope: public
    requiresApproval: true
    timeoutMs: 5000
    parameters:
      type: object
      properties: { email: { type: string, minLength: 3, maxLength: 254 } }
      required: [email]
      additionalProperties: false
    outputSchema:
      type: object
      properties: { accepted: { type: boolean } }
      required: [accepted]
      additionalProperties: false
    executor:
      type: http
      method: POST
      url: https://api.example.com/contact
      allowHosts: [api.example.com]
```
