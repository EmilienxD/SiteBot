# SiteBot deployment checklist

Run `sitebot doctor --production` before exposing the endpoint publicly.

- [ ] `allowedOrigins` lists exactly the intended origins; no wildcard-only entry
- [ ] `auth.mode` is `required` if any tool touches user data
- [ ] Every non-`readOnly` tool is in `approvalRequired`
- [ ] Every HTTP tool has an explicit `allowHosts`
- [ ] MCP imports specify `allow`
- [ ] `budget.maxUsdPerDay` is set and budget breach alerting exists
- [ ] `rateLimit.store` is `redis` when running more than one replica
- [ ] `storage.type` is not `memory` or `none` in production
- [ ] `trustProxy` matches the actual proxy topology
- [ ] Secrets come from `${env.*}` and `.env` is gitignored
- [ ] `sitebot ingest` runs in CI after site deployments
- [ ] Sensitive routes are excluded from page context and knowledge indexing
- [ ] `ui.footer` carries the required privacy/recording notice
- [ ] The widget bundle is self-hosted or pinned with SRI
