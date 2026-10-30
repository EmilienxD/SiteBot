# Source provenance and citations

`ToolContext.sources` is generic framework infrastructure for application-selected evidence. It never fetches or searches a source.

```ts
const ref = ctx.sources.register({
  id: 'public-policy:v1',
  title: 'Public policy',
  url: 'https://example.com/policy',
  text: 'The application-selected supporting excerpt.',
  lang: 'en',
})
return { n: ref.n, text: 'The application-selected supporting excerpt.' }
```

Only trusted server handler code registers evidence. Metadata and text remain untrusted reference data. URLs must be safe absolute HTTP(S) destinations without credentials. Source identity conflicts, metadata limits and source counts are checked. Use a new stable application ID when the underlying source changes.

Each admitted tool call stages its sources in isolation. Sources publish only after successful output validation and deadline checks. Failed, cancelled, invalid or late calls discard staged evidence; they cannot leak into another call. Untrusted client inputs, client tool results and ordinary output URLs never register provenance automatically.

Source numbering is conversation-wide and persists with trusted server history. Citation follow-ups retain source identity; trimmed history cannot silently bind an old number to a new source. The wire `data-citations` payload uses `chunkId` to carry the application source ID for existing widget clients; it does not imply framework chunking or retrieval.

For provider input, carried source records are validated against the retained server source map and deduplicated into one request-local user-role reference-context message before conversation history. It labels source titles, original URLs/languages and short excerpts as untrusted reference data; it is not a visitor request or an assistant-authored answer. Fields are quoted individually, without serializing internal source IDs/objects or adding an XML-like source envelope. The SDK converts actual conversation and tool parts normally, leaving assistant-authored text and genuine source/tool markup unchanged. This context message is not persisted or added to trusted system instructions. At most 32 retained source records with 280-character excerpts are restored, and trimmed/conflicting/unverified sources cannot supply references. Genuine historical tool results remain in their original tool roles; framework citation context is not replayed per earlier answer.

Role separation removes an incorrect assistant-history composition path. It does not guarantee a model's final formatting or prevent it from independently generating source-like markup. Applications must assess final formatting with their selected model; the widget does not suppress such text.

The widget renders individual and grouped numeric citations by lookup in the known source map. Unknown, malformed and duplicate markers are handled safely. Links use registered actual destinations, with localized English/French accessible labels. Ordinary visitor clicks follow citation links. Source text remains untrusted and is never hidden by a special `<sources>` renderer filter.
