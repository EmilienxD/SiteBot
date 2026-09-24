import { defineConfig } from '@sitebot/config'

/**
 * A TypeScript config, because a Worker has no filesystem to read YAML from:
 * src/worker.ts imports this object and the bundler inlines it. The CLI loads
 * the same file for `pnpm ingest` and `pnpm doctor`, so the Worker and the
 * index can never disagree about the embedding model.
 *
 * `${env.X}` placeholders resolve from the Worker's bindings at runtime
 * (.dev.vars locally, `wrangler secret` in production), and from the process
 * environment when the CLI loads it.
 */
export default defineConfig({
  version: 1,
  name: 'Tidepool Tours',
  mode: 'chat',

  backend: {
    provider: 'openai',
    model: '${env.SITEBOT_MODEL:-gpt-5-mini}',
    apiKey: '${env.OPENAI_API_KEY}',
    maxOutputTokens: 600,
  },

  prompt: {
    system: [
      'You are the assistant on the Tidepool Tours website, a small sea-kayak tour',
      'company in Cornwall. Answer questions about tours, prices, what to bring and',
      'booking. Keep answers short and cite the page you used.',
    ].join('\n'),
    includePageContext: true,
    guardrails: {
      refuseOffTopic: true,
      offTopicMessage: 'I can only help with Tidepool Tours — our trips and bookings.',
    },
  },

  siteContext: {
    company: 'Tidepool Tours',
    description: 'Guided sea-kayak tours from Falmouth, Cornwall.',
    primaryUrl: '${env.SITE_URL:-http://localhost:8787}',
  },

  // Sessions live in Workers KV (src/kv-session-store.ts). The Worker passes
  // the store in directly; `custom` records that here for the CLI and docs.
  storage: { type: 'custom', module: './src/kv-session-store.ts#createKvSessionStore' },

  knowledge: {
    // `pnpm ingest` crawls the running Worker's own pages and writes the
    // vectors to Upstash; the Worker only ever queries.
    sources: [
      {
        type: 'crawl',
        url: '${env.SITE_URL:-http://localhost:8787}/',
        maxDepth: 1,
        exclude: ['/admin/**', '/account/**', '/internal/**'],
      },
    ],
    embedding: {
      provider: 'openai',
      model: 'text-embedding-3-small',
      apiKey: '${env.OPENAI_API_KEY}',
    },
    store: {
      type: 'upstash',
      url: '${env.UPSTASH_VECTOR_REST_URL}',
      token: '${env.UPSTASH_VECTOR_REST_TOKEN}',
    },
  },

  ui: {
    theme: { primary: '#0e7490' },
    messages: {
      greeting: 'Hi! Ask me about our kayak tours, prices or what to bring.',
    },
  },
})
