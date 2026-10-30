import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const here = dirname(fileURLToPath(import.meta.url))

const config: NextConfig = {
  output: 'standalone',
  // SiteBot resolves optional SDKs dynamically. A server-only import in
  // lib/sitebot.ts declares this one; externalizing preserves its runtime
  // package for the lazy provider factory after relocation.
  serverExternalPackages: ['@ai-sdk/openai', '@ai-sdk/google'],
  // In this monorepo, trace from its root so workspace packages are included
  // in standalone output. In your own app, delete this line.
  outputFileTracingRoot: resolve(here, '../..'),
  // Config is a runtime input. Include it
  // explicitly instead of tracing every possible configured filesystem path.
  outputFileTracingIncludes: {
    '/api/chat/**': ['./chatbot.config.yaml'],
  },
}

export default config
