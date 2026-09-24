import { createOpenAI } from '@ai-sdk/openai'
import { validateConfig, type ResolvedConfig } from '@sitebot/config'
import { createUpstashVectorStore, type EngineDeps, type QueryEmbedder } from '@sitebot/core'
import { createFetchHandler } from '@sitebot/server/fetch'
import { Index } from '@upstash/vector'
import { embed } from 'ai'
import config from '../chatbot.config'
import { createKvSessionStore } from './kv-session-store'

export interface Env {
  SESSIONS: KVNamespace
  OPENAI_API_KEY: string
  UPSTASH_VECTOR_REST_URL?: string
  UPSTASH_VECTOR_REST_TOKEN?: string
  SITEBOT_MODEL?: string
  SITE_URL?: string
}

/**
 * What a Worker has to hand the engine itself.
 *
 * A Node host loads provider SDKs by name at runtime; a Worker bundle cannot,
 * so the OpenAI and Upstash SDKs are imported statically above and passed in:
 * the chat adapter, the query embedder and the vector index client. The
 * session store wraps the KV binding.
 */
export async function createDeps(resolved: ResolvedConfig, env: Env): Promise<EngineDeps> {
  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY })
  const deps: EngineDeps = {
    adapters: { openai: async (entry) => openai(entry.model) },
    sessionStore: createKvSessionStore(env.SESSIONS, { ttlSeconds: resolved.storage.ttlSeconds }),
  }
  const { store, embedding } = resolved.knowledge
  if (store.type === 'upstash' && embedding !== undefined && store.url && store.token) {
    const model = openai.embedding(embedding.model)
    const embedder: QueryEmbedder = {
      modelId: embedding.model,
      async embed(text) {
        const result = await embed({ model, value: text, maxRetries: 2 })
        return { embedding: result.embedding, tokens: result.usage.tokens }
      },
    }
    deps.knowledge = {
      store: await createUpstashVectorStore({
        url: store.url,
        token: store.token,
        model: embedding.model,
        client: new Index({ url: store.url, token: store.token }),
      }),
      embedder,
    }
  }
  return deps
}

export function resolveConfig(env: Env): ResolvedConfig {
  // Chat works with only OPENAI_API_KEY; retrieval switches on once the
  // Upstash index is configured (and filled by `pnpm ingest`).
  const withUpstash = Boolean(env.UPSTASH_VECTOR_REST_URL && env.UPSTASH_VECTOR_REST_TOKEN)
  const input = withUpstash ? config : { ...config, knowledge: undefined }
  const result = validateConfig(input, { env: env as unknown as Record<string, string> })
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
