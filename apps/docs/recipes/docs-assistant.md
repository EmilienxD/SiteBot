# Docs assistant

An assistant for a documentation site that answers from the docs, cites the pages it used, and says
so when the docs don't cover something. It uses chat mode with no tools, which makes it the cheapest,
most predictable setup: every answer is one retrieval plus one model call.

## The config

```yaml [chatbot.config.yaml]
version: 1
name: Quill Docs
mode: chat

backend:
  provider: openai
  model: gpt-5-mini
  temperature: 0.2

prompt:
  system: |
    You answer questions about Quill, a Markdown publishing tool, using only the
    documentation excerpts you are given. Quote code exactly as it appears.
    If the excerpts do not cover the question, say so plainly and suggest the
    closest page. Never invent options, flags or API names.
  includePageContext: true

siteContext:
  company: Quill
  description: Documentation for Quill, a Markdown publishing tool.
  primaryUrl: https://docs.quill.example

storage:
  type: memory

knowledge:
  sources:
    - type: sitemap
      url: https://docs.quill.example/sitemap.xml
      exclude: ['/blog/**', '/changelog/**']
    - type: files
      glob: ./docs/**/*.md
      baseUrl: https://docs.quill.example
  embedding:
    provider: openai
    model: text-embedding-3-small
  store:
    type: sqlite
    path: ./.sitebot/index.db
  chunk:
    strategy: heading
    maxTokens: 600
  retrieval:
    mode: always
    topK: 6
    minScore: 0.35
    includeCitations: true

ui:
  messages:
    greeting: Ask anything about Quill — I'll point you to the page.
    placeholder: How do I…
```

## Build the index

```bash
npx sitebot ingest --dry-run   # which pages, how many chunks, estimated cost
npx sitebot ingest             # embed and write .sitebot/index.db
```

Run it again after each docs deploy, in CI if you can. Unchanged pages are skipped by content hash, so
re-runs cost almost nothing.

## How it works

- **Two sources, one index.** The sitemap covers the published site. The `files` source reads the
  Markdown sources directly, and `baseUrl` maps each file to its public URL so citations link to the
  real page.
- **Retrieval on every question.** `retrieval.mode: always` retrieves before every answer, rather than
  leaving it to the model to decide (`tool` mode, the agent-mode default).
- **Chunks follow the docs' structure.** `chunk.strategy: heading` splits at headings, so a chunk is
  a section with its heading, which makes citations point at the right place.
- **Weak matches are dropped.** `minScore` filters out low-similarity chunks, so a question the docs
  don't answer gets "the docs don't cover this" instead of an answer stitched from unrelated pages.
- **Citations appear as chips** under the answer, each linking to its source page.
- **No session storage needed.** Chat mode has no approvals to persist, so `memory` is fine even in
  production. Use `redis` if you want conversations to survive a restart.
