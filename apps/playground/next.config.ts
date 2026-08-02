import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const here = dirname(fileURLToPath(import.meta.url))

const config: NextConfig = {
  reactStrictMode: true,
  // Pin the trace root to the monorepo. Next infers it from the nearest
  // lockfile, which in a pnpm workspace can land outside the repo entirely and
  // silently drops the workspace packages from the standalone output.
  outputFileTracingRoot: resolve(here, '../..'),
  // The workspace packages ship real ESM builds, so there is nothing to
  // transpile — but the config loader reads a YAML file at runtime, which the
  // tracer cannot see by following imports.
  outputFileTracingIncludes: {
    '/api/chat/**': ['./chatbot.config.yaml'],
  },
}

export default config
