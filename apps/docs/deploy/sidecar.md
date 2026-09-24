# Separate server (sidecar)

For sites that can't host the chat API themselves, such as WordPress, Django, Rails or a static host,
run a small chat server beside the site. The site's only change is one script tag.

Runnable example:
[`examples/express-sidecar`](https://github.com/EmilienxD/SiteBot/tree/main/examples/express-sidecar),
a Django site with an Express sidecar (and a no-Python fallback).

## The quickest version

The CLI is a complete sidecar:

```bash
npx sitebot serve --port 8787
```

It serves the chat API at `/api/chat` and the widget bundle at `/sitebot.js`, with CORS on both. To embed
it in your own server instead, use an adapter:

```js
import express from 'express'
import { loadConfig } from '@sitebot/config/node'
import { createExpressMiddleware } from '@sitebot/server/express'

const config = await loadConfig(undefined, { dotenv: true })
const app = express()
app.use('/api/chat', createExpressMiddleware(config)) // before any body parser
app.listen(8787)
```

## The three things that must line up

Every request the widget makes goes to another origin:

**1. `security.allowedOrigins` lists the site's origin exactly**, with scheme, host and port, as the
browser sends it. Every other origin is refused, including on the CORS preflight.

```yaml
security:
  allowedOrigins: [https://www.example.com]
  publicKey: pk_example_1
```

**2. The script tag points at the sidecar**, with the full endpoint URL and the public key:

```html
<script
  type="module"
  src="https://chat.example.com/sitebot.js"
  data-endpoint="https://chat.example.com/api/chat"
  data-key="pk_example_1"
></script>
```

`data-key` isn't a secret. It identifies which deployment the widget belongs to, and rotating it cuts off
copies of the snippet pasted onto other sites.

**3. The widget bundle is served with CORS too.** A `<script type="module">` from another origin is
fetched in CORS mode, so without `Access-Control-Allow-Origin` the browser downloads the bundle but
won't run it. `sitebot serve` handles this. If you serve the bundle yourself, send the header for the
same origins as the API.

To check the setup by hand:

```bash
curl -si -X OPTIONS https://chat.example.com/api/chat \
  -H 'origin: https://www.example.com' -H 'access-control-request-method: POST' | head -5
# 204, with access-control-allow-origin: https://www.example.com
```

## Production

- **Behind a load balancer**, set `security.trustProxy` to its hop count. Otherwise every visitor shares
  one rate-limit bucket.
- **With several replicas**, move sessions and rate limits to Redis (`storage.type: redis`,
  `security.rateLimit.store: redis`).
- **For uptime checks**, point your load balancer's probe at `/health`. It reports the real provider and
  storage status and returns 503 when broken, so a bad instance leaves rotation.

Then go through the [production checklist](/deploy/checklist).
