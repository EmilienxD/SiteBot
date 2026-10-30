# Cloudflare Worker example

This example mounts the SiteBot fetch handler, a statically imported OpenAI adapter, and an application-owned Workers KV session store. Configure the provider binding in `.dev.vars` or the deployment secret store. `tools: []` remains empty; add complete application handlers when needed.

Run `pnpm dev` locally or `pnpm build` for a dry-run bundle. Configuration loads from the typed config file and supports English and French. No indexing or context-loading subsystem is included. Verify runtime code-generation support required by Ajv on your target host.
