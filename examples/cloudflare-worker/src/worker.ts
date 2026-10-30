import { createOpenAI } from '@ai-sdk/openai'
import { validateConfig, type ResolvedConfig } from '@sitebot/config'
import { type EngineDeps } from '@sitebot/core'
import { createFetchHandler } from '@sitebot/server/fetch'
import config from '../chatbot.config'
import { createKvSessionStore } from './kv-session-store'

export interface Env {
  SESSIONS: KVNamespace
  OPENAI_API_KEY: string
  SITEBOT_MODEL?: string
  SITE_URL?: string
}

/**
 * What a Worker has to hand the engine itself.
 *
 * A Node host loads provider SDKs by name at runtime; a Worker bundle cannot,
 * so the OpenAI SDK are imported statically above and passed in:
 * the chat adapter. The
 * session store wraps the KV binding.
 */
export async function createDeps(resolved: ResolvedConfig, env: Env): Promise<EngineDeps> {
  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY })
  const deps: EngineDeps = {
    adapters: { openai: async (entry) => openai(entry.model) },
    sessionStore: createKvSessionStore(env.SESSIONS, { ttlSeconds: resolved.storage.ttlSeconds }),
  }
  return deps
}

export function resolveConfig(env: Env): ResolvedConfig {
  const result = validateConfig(config, { env: env as unknown as Record<string, string> })
  if (!result.ok)
    throw new Error(`chatbot.config.ts is invalid:\n${JSON.stringify(result.errors, null, 2)}`)
  return result.value
}

// One handler per isolate, built on the first request: bindings only exist
// inside `fetch`, and rebuilding the engine per request would throw away its
// caches.
let handler: Promise<(request: Request) => Promise<Response>> | undefined

async function build(env: Env): Promise<(request: Request) => Promise<Response>> {
  const resolved = resolveConfig(env)
  return createFetchHandler(resolved, { deps: await createDeps(resolved, env) })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // A failed build is not cached, so the next request retries it.
    handler ??= build(env).catch((error: unknown) => {
      handler = undefined
      throw error
    })
    return (await handler)(request)
  },
} satisfies ExportedHandler<Env>
