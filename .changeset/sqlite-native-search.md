---
'@sitebot/core': patch
'@sitebot/ingest': patch
---

Fix SQLite knowledge indexes to load sqlite-vec on Node 22.13+ and use native cosine search with
metadata filtering. Migrate existing indexes, synchronize vector writes and deletions transactionally,
and support forced model/dimension changes. Ingestion now closes database connections on success and failure.
