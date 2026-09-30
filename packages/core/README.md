# @sitebot/core

The [SiteBot](https://github.com/EmilienxD/SiteBot) engine: provider resolution, prompt composition,
tools and the agent loop, approvals, guards, retrieval, sessions and the streaming protocol. Most
projects use it through [`@sitebot/server`](https://www.npmjs.com/package/@sitebot/server) and never
import it directly.

- **`@sitebot/core`**: `createEngine` and everything edge-safe. No `node:*` imports.
- **`@sitebot/core/node`**: the Node-only pieces: SQLite, Redis and Postgres session stores, the
  SQLite and pgvector vector stores, the SSRF-hardened fetch for HTTP tools, and stdio MCP.

Import it directly when you need to supply your own pieces: a session store, a vector store, a model
adapter on a runtime that can't load provider SDKs by name, or a custom engine for testing.

```ts
import { createEngine } from '@sitebot/core'

const engine = createEngine(config, { sessionStore: myStore })
```

Provider SDKs (`@ai-sdk/anthropic`, `@ai-sdk/openai`, …), `@upstash/vector`, `sqlite-vec` and the MCP SDK
are optional peers: install only what your config uses.

For `knowledge.store.type: sqlite`, use **Node 22.13 or newer** and install
`sqlite-vec@^0.1.9`. Its prebuilt binaries cover Windows x64, Linux x64/arm64 and macOS x64/arm64;
no local compiler is needed. Consumers using another store do not need this dependency.

SQLite uses a `vec0` virtual table for cosine nearest-neighbor search with float32 vectors.
Metadata equality filters apply before selecting the nearest matches. Writes and deletions update
the chunk and vector tables in one transaction; existing JSON-only indexes are migrated on open.
Embeddings must have 1–8192 dimensions and finite float32 values. Changing the model or dimensions
requires clearing the old corpus (`sitebot ingest --force`); an empty index can then change dimensions.
Original embeddings, citation metadata and document order remain available for neighbour expansion.
