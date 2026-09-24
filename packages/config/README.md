# @sitebot/config

The configuration schema, loader and types for [SiteBot](https://github.com/EmilienxD/SiteBot).

- **`@sitebot/config`**: `validateConfig`, `defineConfig`, the Zod schemas and types. Runs anywhere,
  including browsers and edge runtimes.
- **`@sitebot/config/node`**: `loadConfig`, which finds and reads `chatbot.config.{yaml,ts,mjs,json,toml}`,
  applies `extends`, loads `.env` files and validates.
- **`@sitebot/config/schema/chatbot.schema.json`**: a JSON Schema for editor autocomplete.

```ts
import { loadConfig } from '@sitebot/config/node'

const config = await loadConfig(undefined, { dotenv: true })
```

```ts
// chatbot.config.ts
import { defineConfig } from '@sitebot/config'

export default defineConfig({
  extends: './chatbot.config.yaml',
  tools: [
    {
      name: 'quote',
      description: '…',
      execute: async (input) => ({ price: 42 }),
    },
  ],
})
```

For autocomplete in YAML, add this as the first line:

```yaml
# yaml-language-server: $schema=./node_modules/@sitebot/config/schema/chatbot.schema.json
```

Invalid configs fail with the key, the value, what was expected and how to fix it. Every key is in
[`docs/02-configuration.md`](https://github.com/EmilienxD/SiteBot/blob/main/docs/02-configuration.md).
