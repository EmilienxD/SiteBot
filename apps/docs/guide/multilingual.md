# Multilingual assistants

SiteBot includes complete English (`en`) and French (`fr`) catalogs for its controls, accessibility labels, statuses, errors and limits. No translation service is required. Product names, legal notices, greetings and other brand copy remain deployment configuration.

## Select the language

The widget and server share a locale resolver. The order is:

1. An explicit host override: `locale` in JavaScript/React, `data-locale` on the script or custom element, or `SiteBot.setLocale(...)`.
2. The host website's `<html lang="...">`.
3. `navigator.languages`, then `navigator.language`.
4. `ui.locale`, the configured fallback. `auto` uses English when available; otherwise the first supported locale is used.

Tags are validated and canonicalized using `Intl.getCanonicalLocales`. A regional tag first tries an exact supported locale, then its parents: `fr-CA` resolves to `fr` with the default configuration. Invalid/empty tags are skipped. A valid but unsupported explicit or document language uses the deployment fallback; it does not let an English browser override the language chosen by the website. Browser preferences are tried in preference order until a supported language is found.

`ui.supportedLocales` is the deployment allowlist, enforced in both browser and server. It defaults to `[en, fr]`. To restrict a deployment to French, use `supportedLocales: [fr]` and `locale: fr`.

**Migration:** `ui.locale` now supplies the final fallback, rather than forcing the browser's language. To pin a specific host's language, use the explicit host override. To restrict all clients, set `ui.supportedLocales`.

```html
<html lang="fr">
  <!-- With no override, French wins over an English browser. -->
  <script type="module" src="/sitebot.js" data-endpoint="/api/chat"></script>
</html>
```

An explicit override works independently of a framework:

```html
<script
  type="module"
  src="/sitebot.js"
  data-endpoint="/api/chat"
  data-locale="fr-CA"
></script>
<!-- Alternatively: <site-chat data-endpoint="/api/chat" data-locale="fr"></site-chat> -->
```

```js
window.SiteBotConfig = { endpoint: '/api/chat', locale: 'fr' }
// Or, with a bundler:
// defineSiteBot({ endpoint: '/api/chat', locale: 'fr' })
window.SiteBot.setLocale('fr-CA')
window.SiteBot.setLocale('auto') // Resume following the host document.
```

```tsx
<ChatWidget endpoint="/api/chat" locale={selectedLanguage} />
```

On a custom element, `element.configure({ locale: 'fr' })` and `element.setLocale('fr')` update the same override. Programmatic options take precedence over that element's `data-locale`. `window.SiteBotConfig` takes precedence over script attributes. `auto` clears the effective override and resumes automatic selection.

The widget observes changes to `document.documentElement.lang` and listens for browser `languagechange` events. A client-side router only needs to update `<html lang>` or call `setLocale`. Controls, accessibility labels, configured copy, and subsequent requests use the new locale. The conversation and session remain intact. Existing user/model messages keep their original text. An in-flight model response finishes in the language requested when it began; a language switch does not restart it. The separate, opt-in `resetOnNavigate` behavior still resets on navigation as documented.

## Translate deployment copy

`ui.strings.<locale>` overrides shared catalog keys. `ui.translations.<locale>` overlays the deployment-owned messages, suggestion labels **and their send text**, launcher label/badge text, panel title, accessibility labels, and footer text/links. These blocks are public, like the rest of `ui`; never put credentials or private content in them.

```yaml
ui:
  locale: en
  supportedLocales: [en, fr]
  messages:
    greeting: Welcome to Example. How can we help?
    suggestions:
      - label: Getting started
        action: { type: send, text: How do I get started? }
  translations:
    fr:
      messages:
        greeting: Bienvenue chez Example. Comment pouvons-nous vous aider ?
        placeholder: Posez votre question à Example…
        suggestions:
          - label: Premiers pas
            action: { type: send, text: Comment démarrer ? }
      launcher: { label: Besoin d’aide ? }
      panel: { title: Assistance Example }
      footer:
        text: Consultez notre politique de confidentialité.
        linkText: Confidentialité
        linkUrl: https://example.com/privacy
  strings:
    fr:
      send: Envoyer
      retryIn: 'Réessayer dans {seconds} s'
```

Catalog precedence is English defaults → configured fallback catalog/overrides → selected language catalog/overrides, with base language before regional overrides. Missing deployment copy falls back through configured fallback translations to the base `ui` fields. Legacy English schema defaults for placeholder, generic error and accessibility labels defer to the selected catalog. To intentionally retain the exact English default in another language, put it in `ui.strings.<locale>`.

For greeting, placeholder, generic error and accessibility labels, `ui.strings` takes precedence over the corresponding deployment-copy fields. Unknown message keys or altered interpolation placeholders fail configuration validation. Interpolations are named, such as `{seconds}`, `{tool}`, `{n}` and `{title}`; missing values remain visible as placeholders. Rendering uses text/escaped Markdown as before. The renderer supports simple named interpolation, not ICU plural/select syntax.

Dynamic `setSuggestions` and tool-generated suggestions are deployment/model content and are not automatically translated. A host-provided list applies until replaced or reset. Locale-tagged server suggestions apply only to that locale; switching language returns to the configured translated list.

## Requests and model instructions

Every chat POST (including retry/resume) includes a canonical, resolved `locale`, independently of page-context capture. The widget also sets `Accept-Language` and `pageContext.locale` to that locale. This prevents a French website with an English browser from sending English requests.

For direct API callers, send `locale: 'fr'` in the body. The server validates this tag and applies `ui.supportedLocales`. Older clients fall back to `pageContext.locale`, then quality-weighted `Accept-Language`, then the configured fallback. Malformed body locale tags are rejected with `invalid_request`. Locale is a presentation preference, never an authorization control.

The engine uses the same locale for built-in responses, search status, limits, default handoff text, retrieval, and the model's language instruction. The model normally answers in that language, but is instructed to honor an explicit conversational request for another response language. Operator prompts/hooks can still conflict with this instruction; author them accordingly. Language compliance is a model behavior, not a deterministic guarantee.

The language policy belongs to the locale-dependent cached prompt segment. The deployment prefix remains reusable; English and French policies cannot share the same cached text. `/config` returns all public catalogs/copy without negotiating a language, so its existing shared cache needs no language-dependent variation. Session probes remain `private, no-store`. Private prompts, provider credentials and knowledge source configuration remain outside the public allowlist.

## Documentation languages

Ingest detects a valid HTML `<html lang>` for crawled, sitemap and HTML file documents. Set `lang` on any source to override detection, or to label Markdown, JSON, text or OpenAPI content:

```yaml
knowledge:
  sources:
    - type: sitemap
      id: docs-en
      url: https://example.com/en/sitemap.xml
      lang: en
    - type: files
      id: docs-fr
      glob: docs/fr/**/*.md
      baseUrl: https://example.com
      lang: fr
```

Choose `baseUrl` to match real public file destinations; SiteBot retains the configured URL mapping and never constructs a translated destination. A source with mixed page languages should omit `lang` and let HTML detection identify each page. Language is not inferred from URL paths or prose. Unknown-language documents stay unlabelled.

Chunks retain their original canonical `lang` (for example `fr-CA`) and a `language` primary-language field (`fr`) for existing store equality filters. The manifest preserves language through conditional HTTP requests and detects changes to source overrides and document language. Rebuild an older index with `sitebot ingest --force` to populate this metadata.

For inline retrieval and `search_knowledge_base`, SiteBot embeds the query once and combines bounded global, exact-locale and language-family candidates. It deduplicates the pool, optionally reranks it in one call, and applies `minScore` before selecting excerpts.

`knowledge.retrieval.languagePreference: relevance` is the default: score comes first, with exact locale and then language family breaking equal-score ties. A weaker French hit cannot hide stronger English evidence merely by passing `minScore`. This policy uses the configured scorer; it cannot determine whether an embedding's scores are semantically correct or calibrated across languages. No universal cross-language margin is assumed. Validate the model on representative queries; a multilingual reranker can help when vector scores are misleading.

Set `languagePreference: locale-first` to retain the earlier policy: choose suitable exact-locale results, otherwise suitable language-family results, otherwise all-language fallback. “Suitable” means passing configured reranking and `minScore`; this policy deliberately lets any suitable preferred-language hit suppress other languages. It does not fill unused slots from another language.

Both policies share `topK` and the context-token budget. Unknown-language content remains eligible in the global pool. Existing metadata filters remain in effect on every query; an explicit deployment `filter.lang` or `filter.language` takes precedence over automatic preference. Custom stores must implement the metadata equality-filter contract. This change affects the default ordering of existing bilingual deployments; choose `locale-first` explicitly if you require the old behavior.

Prompt snippets, tool search results and citations preserve source language and the actual source URL. A French answer may therefore cite an English page when French documentation is unavailable or unsuitable. SiteBot neither translates the corpus nor fabricates language variants. A conversational request for another answer language affects model wording; retrieval continues to use the host-selected locale.

## Add another language

For a deployment, adding a language is configuration work:

1. Create a complete catalog using the exported `Catalog` type and English keys from `@sitebot/config/i18n`. Translate each value, preserving its named placeholders. Check it with `validateCatalog(catalog)`; an empty array means it is complete and valid.
2. Add the locale to `ui.supportedLocales` and put the catalog in `ui.strings.<locale>`. A TypeScript config can import a local catalog; YAML/JSON configs can contain the same key/value mapping. Regional variants can supply only their differing keys.
3. Add branded copy under `ui.translations.<locale>`. Set `ui.locale` if this language should be the final fallback. Update the host `<html lang>` or explicit locale option.
4. Label that language's knowledge sources with `lang` when HTML detection is unavailable, then run ingest. Verify that citation URLs correspond to real pages.

```ts
import { en, validateCatalog, type Catalog } from '@sitebot/config/i18n'
// Start with these keys, translate every value, and preserve placeholders.
const catalog: Catalog = { ...en /* replace every English value with the translation */ }
if (validateCatalog(catalog).length) throw new Error('Incomplete or invalid catalog')
// Merge into your deployment config:
// ui: { supportedLocales: ['en', 'fr', 'es'], strings: { es: catalog } }
```

To ship a language as a SiteBot built-in, add a catalog module beside `packages/config/src/i18n/en.ts`, use `satisfies Catalog`, and register/export it in `i18n/index.ts`. Add its two launcher messages in `i18n/launcher-catalogs.ts`; the locale resolver, config schema and widget derive their default supported locales from that small registry. This keeps the complete panel catalogs lazy while the launcher can localize immediately. The parameterized catalog tests then check it automatically. No engine, widget-control or retrieval language branches are needed.

The regression suite uses offline DOM, scripted model, ingest and vector fixtures to check these mechanics. It does not measure live multilingual generation, translation or semantic embedding quality. Select an embedding model that supports the languages in your corpus and validate relevance with representative real queries before deployment.

The opt-in shared-store checks also exercise real pgvector equality filters, relevance ordering,
regional-language fallback and citation metadata with synthetic vectors. Ingestion keeps model,
dimensions and document-prefix compatibility in its manifest; preserve that manifest between runs
and rebuild all sources when changing embedding space. The pgvector table records the indexed model,
but does not enforce the complete prefix/dimension fingerprint for a separate ingester that has lost
its manifest. Keep one coordinated ingestion workflow per corpus and use the matching query model,
dimensions and input conventions on every replica. See [shared deployment state](/deploy/in-app#shared-state-and-limits)
for session/citation continuity and concurrency limits.

Some embedding models require task-specific inputs. Configure `knowledge.embedding.documentPrefix` and `queryPrefix` when the model's official documentation requires textual prefixes. They affect embedding inputs only; source excerpts, URLs and languages stay intact. A document-prefix change requires `sitebot ingest --force` for all sources. Cohere and Voyage adapters send their documented query/document `input_type` automatically. For example, [Nomic Embed v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) requires `search_document: ` and `search_query: ` respectively; its model card labels it English, so successful French examples do not establish multilingual suitability.

The [docs assistant recipe](/recipes/docs-assistant#run-local-live-validation) includes an opt-in local
Ollama check with real ingestion, embeddings, server Q&A, language changes and source citations. Its
quality assertions may fail for the selected model pair; a skipped or failing run does not validate
multilingual answer quality.
