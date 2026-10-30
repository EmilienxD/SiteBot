# Documentation assistant

The consuming application owns this tool, its data access, and its service implementation. Replace the example endpoint or module with your application implementation. SiteBot validates the schemas, permissions, deadline and result.

```yaml [chatbot.config.yaml]
version: 1
name: Documentation assistant
mode: chat
backend:
  provider: openai
  model: gpt-5-mini
prompt:
  system: Answer from the application-selected public policy. Cite supplied source numbers.
ui:
  locale: auto
  supportedLocales: [en, fr]
tools:
  - name: read_public_policy
    description: Read the public policy selected by this application.
    readOnly: true
    scope: public
    requiresApproval: false
    timeoutMs: 3000
    parameters: { type: object, additionalProperties: false }
    outputSchema:
      type: object
      properties: { n: { type: integer }, text: { type: string } }
      required: [n, text]
      additionalProperties: false
    executor: { type: module, path: ./tools/public-policy.mjs }
```

The consumer-owned module can be as small as this example. Real applications choose and load their approved context themselves; SiteBot does not provide document loading or search.

```js [tools/public-policy.mjs]
export default function (_input, ctx) {
  const text = 'Support is available Monday to Friday.'
  const { n } = ctx.sources.register({
    id: 'public-policy:v1', title: 'Support policy',
    url: 'https://example.com/support', text, lang: 'en',
  })
  return { n, text }
}
```

Source text remains untrusted reference data. Source registration publishes only after successful validated execution. See the [tool and source API](https://github.com/EmilienxD/SiteBot/blob/main/docs/05-tools.md).
