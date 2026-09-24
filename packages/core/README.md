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
