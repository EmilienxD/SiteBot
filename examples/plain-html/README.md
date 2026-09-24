# Example: plain HTML (no build step)

Harbor & Pine is a made-up coffee roastery with a four-page static site (`public/`) and one config file
(`chatbot.config.yaml`). The pages carry just one script tag and no other integration code.

## Run it

From the repo root, run `pnpm install && pnpm build` once. Then:

```bash
cd examples/plain-html
ANTHROPIC_API_KEY=sk-ant-… pnpm dev
```

To run fully local with no API key, use [Ollama](https://ollama.com) with any model that supports tool calling:

```bash
ollama pull qwen2.5:14b
SITEBOT_PROVIDER=ollama SITEBOT_MODEL=qwen2.5:14b pnpm dev
```

Open http://localhost:3000. `sitebot dev` serves `public/`, the chat endpoint at `/api/chat` and the
local widget bundle from one process. It reloads when the config changes. Add `--inspect` to log
request bodies and stream events.

## What to try

| Ask                                                 | What it exercises                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| "How much is the Ethiopia Yirgacheffe?" on Shop     | Live page context: the answer comes from the page the visitor is on                      |
| "How do I store beans?" on Brewing                  | `highlight_section` client tool: scrolls to and highlights the paragraph                 |
| "Take me to the shop"                               | Built-in `navigate`, restricted to `siteContext.routes`                                  |
| "Fill the wholesale form for Tidewater Cafe, 30 kg" | `fill_wholesale_form`: approval card first, then the page fills the form (never submits) |

## Files

- `public/*.html` are the host pages. Each has one `<script type="module" src="/sitebot.js" data-endpoint="/api/chat">`.
- `chatbot.config.yaml` holds the provider, prompt, site facts and routes, tools and theme. Sessions are stored in SQLite under
  `.sitebot/`, which agent mode needs so approvals survive a page reload.

## Production

`pnpm start` runs `sitebot serve` with the same static directory. Before exposing it, run `pnpm doctor --production`
and read [`docs/deployment-checklist.md`](../../docs/deployment-checklist.md).
