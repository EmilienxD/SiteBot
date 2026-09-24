import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const here = dirname(fileURLToPath(import.meta.url))

const config: NextConfig = {
  // In this monorepo, trace from its root so workspace packages are included
  // in standalone output. In your own app, delete this line.
  outputFileTracingRoot: resolve(here, '../..'),
  // The config file is read at runtime, which the tracer cannot see.
  outputFileTracingIncludes: { '/api/chat/**': ['./chatbot.config.yaml'] },
}

export default config
