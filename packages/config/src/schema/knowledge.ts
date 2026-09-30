import { z } from 'zod'
import { GlobSchema, SelectorSchema } from './primitives.js'

export const SOURCE_TYPES = ['sitemap', 'crawl', 'files', 'openapi', 'text', 'json'] as const
export const CHUNK_STRATEGIES = ['semantic', 'heading', 'fixed'] as const
export const EXTRACT_FORMATS = ['markdown', 'text'] as const
export const RETRIEVAL_MODES = ['tool', 'always', 'hybrid'] as const
export const STORE_TYPES = ['memory', 'sqlite', 'pgvector', 'upstash', 'custom'] as const
export const EMBEDDING_PROVIDERS = [
  'openai',
  'google',
  'mistral',
  'cohere',
  'voyage',
  'ollama',
  'openai-compatible',
] as const

// ── sources ─────────────────────────────────────────────────────────────────

/** docs/06-knowledge.md §3.2. */
export const SitemapSourceSchema = z.strictObject({
  type: z.literal('sitemap'),
  id: z.string().min(1).optional(),
  url: z.string().min(1),
  include: z.array(GlobSchema).default([]),
  exclude: z.array(GlobSchema).default([]),
  maxPages: z.number().int().positive().optional(),
})

export const CrawlSourceSchema = z.strictObject({
  type: z.literal('crawl'),
  id: z.string().min(1).optional(),
  url: z.string().min(1),
  maxDepth: z.number().int().min(0).default(3),
  maxPages: z.number().int().positive().optional(),
  respectRobots: z.boolean().default(true),
  include: z.array(GlobSchema).default([]),
  exclude: z.array(GlobSchema).default([]),
})

export const FilesSourceSchema = z.strictObject({
  type: z.literal('files'),
  id: z.string().min(1).optional(),
  glob: GlobSchema,
  baseUrl: z
    .string()
    .optional()
    .describe('Maps file paths to public URLs so citations link somewhere.'),
})

export const OpenApiSourceSchema = z
  .strictObject({
    type: z.literal('openapi'),
    id: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .check((ctx) => {
    if (ctx.value.url === undefined && ctx.value.path === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['url'],
        message: 'An openapi source needs either `url` or `path`.',
      })
    }
  })

export const TextSourceSchema = z.strictObject({
  type: z.literal('text'),
  id: z.string().min(1),
  content: z.string().min(1),
})

export const JsonSourceSchema = z.strictObject({
  type: z.literal('json'),
  id: z.string().min(1).optional(),
  path: z.string().min(1),
  jsonPath: z.string().min(1).optional(),
  template: z
    .string()
    .min(1)
    .describe('Renders each record into text, e.g. "{name} — {description}".'),
})

export const KnowledgeSourceSchema = z.discriminatedUnion('type', [
  SitemapSourceSchema,
  CrawlSourceSchema,
  FilesSourceSchema,
  OpenApiSourceSchema,
  TextSourceSchema,
  JsonSourceSchema,
])

// ── pipeline stages ─────────────────────────────────────────────────────────

export const ExtractSchema = z.strictObject({
  selector: SelectorSchema.default('main, article, [role="main"]'),
  strip: z.array(SelectorSchema).default(['nav', 'footer', 'aside', '.cookie-banner']),
  format: z.enum(EXTRACT_FORMATS).default('markdown'),
  minChars: z
    .number()
    .int()
    .min(0)
    .default(200)
    .describe('Pages shorter than this after extraction are skipped.'),
  renderJs: z
    .boolean()
    .default(false)
    .describe('Fetch through a headless browser. Slow; for SPA-rendered sites.'),
})

export const ChunkSchema = z.strictObject({
  strategy: z.enum(CHUNK_STRATEGIES).default('semantic'),
  maxTokens: z.number().int().positive().default(512),
  overlapTokens: z.number().int().min(0).default(64),
  minTokens: z.number().int().min(0).default(64),
})

export const EmbeddingSchema = z.strictObject({
  provider: z.enum(EMBEDDING_PROVIDERS),
  model: z.string().min(1),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
  batchSize: z.number().int().positive().default(96),
})

// ── store ───────────────────────────────────────────────────────────────────

export const MemoryStoreSchema = z.strictObject({
  type: z.literal('memory'),
  path: z
    .string()
    .optional()
    .describe('Optional JSON file to persist the in-memory index between runs.'),
})

export const SqliteStoreSchema = z.strictObject({
  type: z.literal('sqlite'),
  path: z.string().min(1).default('./.sitebot/index.db'),
})

export const PgVectorStoreSchema = z.strictObject({
  type: z.literal('pgvector'),
  url: z.string().min(1),
  table: z.string().min(1).default('sitebot_chunks'),
})

export const UpstashStoreSchema = z.strictObject({
  type: z.literal('upstash'),
  url: z.string().min(1),
  token: z.string().min(1),
})

export const CustomStoreSchema = z.strictObject({
  type: z.literal('custom'),
  module: z.string().min(1).describe('Path to a module implementing the VectorStore interface.'),
})

export const VectorStoreSchema = z.discriminatedUnion('type', [
  MemoryStoreSchema,
  SqliteStoreSchema,
  PgVectorStoreSchema,
  UpstashStoreSchema,
  CustomStoreSchema,
])

// ── retrieval ───────────────────────────────────────────────────────────────

export const RetrievalSchema = z.strictObject({
  mode: z
    .enum(RETRIEVAL_MODES)
    .optional()
    .describe('Defaults to `always` in chat mode and `tool` in agent mode.'),
  topK: z.number().int().positive().default(6),
  minScore: z.number().min(0).max(1).default(0.3),
  maxContextTokens: z.number().int().positive().default(3000),
  includeCitations: z.boolean().default(true),
  rerank: z
    .union([
      z.boolean(),
      z.discriminatedUnion('provider', [
        z.strictObject({
          provider: z.literal('cohere'),
          model: z.string().min(1).default('rerank-v3.5'),
          apiKey: z.string().optional(),
          baseUrl: z.url().default('https://api.cohere.com'),
          timeoutMs: z.number().int().positive().default(10000),
        }),
        z.strictObject({
          provider: z.literal('custom'),
          module: z
            .string()
            .min(1)
            .describe('Module exporting a Reranker (or a factory returning one).'),
        }),
      ]),
    ])
    .default(false)
    .describe(
      'true uses Cohere rerank-v3.5 and COHERE_API_KEY; an object configures Cohere or a local custom cross-encoder.',
    ),
  dedupeByUrl: z
    .boolean()
    .default(true)
    .describe('At most one chunk per URL, so one long page cannot dominate.'),
  expandNeighbours: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Pull N adjacent chunks around each hit from the same document.'),
  filter: z.record(z.string(), z.unknown()).optional(),
})

export const KnowledgeSchema = z
  .strictObject({
    sources: z
      .array(KnowledgeSourceSchema)
      .default([])
      .describe('Empty means the whole knowledge subsystem stays inert.'),
    extract: ExtractSchema.prefault({}),
    chunk: ChunkSchema.prefault({}),
    embedding: EmbeddingSchema.optional(),
    store: VectorStoreSchema.prefault({ type: 'memory' }),
    retrieval: RetrievalSchema.prefault({}),
  })
  .describe('docs/02-configuration.md §9, docs/06-knowledge.md.')

export type KnowledgeSource = z.output<typeof KnowledgeSourceSchema>
export type Knowledge = z.output<typeof KnowledgeSchema>
