# Example: Express sidecar for a site that isn't JavaScript

Fernhill Dental is a made-up dental practice whose website is a small Django app. The chat runs in a
separate Express server beside it, and the site's only change is one `<script>` tag. It shows the setup
you need when the site can't host the chat API itself: WordPress, Django, Rails, a static host.

```
http://localhost:8000   the site (Django, or a Node fallback)   pages with one <script> tag
http://localhost:8787   the chat sidecar (Express)              /widget/sitebot.js, /api/chat/*
```

Every request the widget makes goes to another origin, so three things have to line up:

1. **`security.allowedOrigins`** lists the site's origin exactly as the browser sends it: scheme, host
   and port. The sidecar refuses every other origin, including on the CORS preflight.
2. **`security.publicKey`** matches the tag's `data-key`. It isn't a secret; it identifies which
   deployment the widget belongs to. Rotate it to cut off copies of the snippet on other sites.
3. **The widget bundle needs CORS too.** A `<script type="module">` from another origin is fetched in
   CORS mode, and without `Access-Control-Allow-Origin` the browser downloads it but won't run it.
   `server.mjs` sends the header for the same allowlist.

## Run it

From the repo root, run `pnpm install && pnpm build` once. Then, in two terminals:

```bash
cd examples/express-sidecar
cp .env.example .env.local        # set ANTHROPIC_API_KEY
pnpm start                        # the sidecar, on :8787
```

```bash
cd examples/express-sidecar
pip install django                # once
pnpm site                         # the Django site, on :8000
```

Open http://localhost:8000.

**No Python?** Run `pnpm site:static` instead of `pnpm site`. It serves the same two pages on :8000
with a 20-line Node server. That's all the cross-origin setup needs, because the chat server can't tell
what rendered the page.

## Check the cross-origin setup by hand

```bash
# Allowed origin: 204, with access-control-allow-origin: http://localhost:8000
curl -si -X OPTIONS http://localhost:8787/api/chat \
  -H 'origin: http://localhost:8000' -H 'access-control-request-method: POST' | head -8

# Any other origin: 403, with no CORS headers
curl -si -X OPTIONS http://localhost:8787/api/chat \
  -H 'origin: https://evil.example' -H 'access-control-request-method: POST' | head -3
```

## Files

| File                    | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `server.mjs`            | Express: the chat middleware at `/api/chat`, the widget bundle at `/widget`  |
| `chatbot.config.yaml`   | Prompt and site facts, plus `allowedOrigins` and `publicKey` for the sidecar |
| `site/app.py`           | The whole Django site: settings, two URLs, templates from `site/pages/`      |
| `site/pages/*.html`     | The pages. The only chat-related line is the `<script>` tag at the bottom    |
| `site/serve-static.mjs` | The no-Python fallback for the site                                          |

## Production

- Put the sidecar on its own subdomain, e.g. `chat.example.com`. Set `SITE_ORIGIN` (or edit
  `allowedOrigins`) to the site's real `https://` origin, and change the script tag's `src` and
  `data-endpoint` to match.
- Behind a load balancer, set `security.trustProxy` to its hop count, or every visitor shares one rate
  limit bucket.
- With more than one replica, move sessions and rate limits to Redis (`storage.type: redis`,
  `security.rateLimit.store: redis`).
- Instead of serving the bundle yourself, you can load it from a CDN with an `integrity` hash.

Run `pnpm doctor --production` and read [`docs/deployment-checklist.md`](../../docs/deployment-checklist.md)
before going live.
