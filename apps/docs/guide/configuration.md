# Configuration

Everything about an assistant lives in one file, `chatbot.config.yaml`, or `.ts`, `.mjs`, `.json`,
`.toml`. This page explains how the pieces fit. Every individual key is in the
[configuration reference](/reference/configuration).

## The smallest config

```yaml
version: 1
name: Acme Assistant

backend:
  provider: anthropic
  model: claude-sonnet-5

prompt:
  system: You are the assistant on Acme's website. Keep answers short.
```

Everything else has a default. Add the editor hint on the first line for autocomplete and inline errors:

```yaml
# yaml-language-server: $schema=./node_modules/@sitebot/config/schema/chatbot.schema.json
```

## Secrets and the environment

Never write a key into the file. Any string can read the environment:

```yaml
backend:
  apiKey: ${env.ANTHROPIC_API_KEY}              # required: startup fails if unset
  model: ${env.SITEBOT_MODEL:-claude-sonnet-5}  # with a default
```

`apiKey` is optional anyway: each provider falls back to its conventional variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and so on). The CLI reads `.env` and `.env.local` next to the
config. In your own server code, pass `loadConfig(path, { dotenv: true })` to get the same.
`sitebot doctor` flags anything that looks like a literal secret.

## Chat or agent

`mode` is the main policy switch.

- **`chat`** (default) is one step. The model may call read-only tools, then answers. It's cheap,
  predictable, and needs no session storage.
- **`agent`** allows multiple steps, up to `agent.maxSteps`, and tools that change things. Every
  writable tool shows the visitor an approval card first. Approvals must survive a page reload, so agent
  mode needs persistent `storage` (sqlite, redis, postgres or custom).

## What the assistant knows

Four sources, cheapest first:

| Source          | Set with             | Good for                                                   |
| --------------- | -------------------- | ---------------------------------------------------------- |
| System prompt   | `prompt.system`      | Role, tone, rules                                          |
| Site context    | `siteContext`        | Company facts, routes, glossary: short and always included |
| Page context    | `prompt.includePageContext` | The page the visitor is looking at, extracted by the widget |
| Knowledge index | `knowledge` + `sitebot ingest` | Everything else, retrieved per question and cited |

Page context includes an outline of the page's forms, with field names and select options but never
values, so form-filling tools know what a field accepts. `ui.pageContext.redactSelectors` and
`excludePaths` keep sensitive parts of a page out of it.

## Tools

Tools let the model look things up and act. Each has a JSON-Schema `parameters` block and an
`executor`, which decides where it runs:

| `executor.type` | Runs                                    | Example                                  |
| --------------- | --------------------------------------- | ---------------------------------------- |
| `http`          | On the server, as an HTTP request       | Order status, stock level, booking slots |
| `mcp`           | On an MCP server                        | Anything an MCP server exposes           |
| `module`        | Your code, on the server                | Custom logic                             |
| `builtin`       | Built in: `list_site_sections`, `navigate`… | Navigation                           |
| `client`        | In the visitor's browser                | `highlight`, `fill_form`, your own `SiteBot.registerTool` |

Mark a tool `readOnly: true` only if it really changes nothing. In agent mode, `requiresApproval` and
`approvalSummary` control the approval card. The [recipes](/recipes/) show each executor type in a
complete config.

## Splitting a config

A `chatbot.config.ts` can `extend` a YAML file and add what YAML can't express, such as inline
`execute` functions and hooks:

```ts
import { defineConfig } from '@sitebot/config'

export default defineConfig({
  extends: './chatbot.config.yaml',
  tools: [{ name: 'quote', description: '…', execute: async (input) => ({ price: 42 }) }],
})
```

Objects deep-merge; the TS file wins. Arrays are replaced, except `tools` (merged by name) and
`knowledge.sources` (concatenated). An object whose `type` changes, such as `storage` going from
`sqlite` to `memory`, is replaced rather than merged.

## Checking a config

```bash
npx sitebot validate          # schema, cross-field rules and tool lint
npx sitebot doctor            # plus the environment: keys, packages, provider, storage, index
```

Errors name the exact key, the value, what was expected and how to fix it. For a typo, they suggest the
key you meant.
