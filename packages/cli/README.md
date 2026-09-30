# @sitebot/cli

The `sitebot` command for [SiteBot](https://github.com/EmilienxD/SiteBot).

```bash
npx sitebot init                   # detect your framework, draft a config from your homepage, scaffold the route
npx sitebot validate               # schema, cross-field rules and tool lint
npx sitebot doctor                 # keys, packages, provider, CORS, storage, knowledge index, with fixes
npx sitebot doctor --production    # the production audit
npx sitebot ingest [--dry-run]     # build the knowledge index
npx sitebot dev                    # a playground page with the widget, reloading on config changes
npx sitebot serve [--static dir]   # the chat API as a standalone server (a sidecar)
```

`sitebot serve` serves the widget bundle at `/sitebot.js` too, so a site on another origin can load it
from the sidecar. `--static` serves a directory of pages from the same process.

Requires Node.js 22.5 or later (22.18 or later to load a `chatbot.config.ts` directly).
SQLite knowledge indexes additionally require Node.js 22.13 or later and `sqlite-vec@^0.1.9`.
