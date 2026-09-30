import type { KnowledgeSource, ResolvedConfig } from '@sitebot/config'
import { createNodeVectorStore } from '@sitebot/core/node'
import type { Chunk, VectorStore } from '@sitebot/core'
import { chunkDocument, type DocumentInput, type RawChunk } from './chunk.js'
import { createEmbeddingModel, dollarsPerMillionTokens, embedChunks } from './embedding.js'
import {
  assertModelCompatible,
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestDocument,
} from './manifest.js'
import {
  loadCrawl,
  loadFiles,
  loadJson,
  loadOpenApi,
  loadSitemap,
  loadText,
  type HttpFetchOptions,
  type RawDocument,
} from './sources.js'
import { sha256 } from './hash.js'

/**
 * `runIngest` — the whole pipeline, docs/06 §3.1 and §5.
 *
 * The shape of the run report matches the CLI's structural `IngestRun` so
 * `printRun` in the command stays a formatter. `--dry-run` executes the same
 * plan with zero writes and zero embedding spend: fetches, extraction and
 * chunking run, embeddings are counted (not sent), store and manifest stay
 * untouched.
 *
 * The idempotency property is tested, not implied: a second run over an
 * unchanged corpus makes no embedding calls (`Option.embedder` counts).
 */
export interface IngestRun {
  sources: {
    id: string
    type: KnowledgeSource['type']
    label: string
    found: number
    unchanged: number
    changed: number
    added: number
    removed: number
  }[]
  chunksAffected: number
  embedding: { chunks: number; batches: number; tokens: number; estimatedUsd: number }
  index: { chunks: number; documents: number; lastIndexed: string }
  dryRun: boolean
}

export interface IngestOptions {
  sourceIds?: string[]
  force?: boolean
  dryRun?: boolean
  concurrency?: number
  onProgress?: (message: string) => void
  /** Injected by tests. Defaults to the config store. */
  store?: VectorStore
  /** Injected by tests; avoids needing any real embedding SDK installed. */
  embedder?: {
    embedBatch(texts: string[]): Promise<{ embeddings: number[][]; tokens: number }>
  }
  manifestDir?: string
  fetchImpl?: typeof fetch
  baseDir?: string
}

interface PlannedDocument {
  document: DocumentInput
  chunks: RawChunk[]
  status: 'added' | 'unchanged' | 'changed'
  /** A 304 carries no body to chunk; its chunks are the manifest's. */
  keptChunkHashes?: string[]
  etag?: string
  lastModified?: string
}

interface PlannedSource {
  source: KnowledgeSource
  label: string
  documents: PlannedDocument[]
  removedChunkIds: string[]
  removedDocuments: number
}

export async function runIngest(
  config: ResolvedConfig,
  options: IngestOptions = {},
): Promise<IngestRun> {
  const embedding = config.knowledge.embedding
  if (embedding === undefined) {
    throw new Error('knowledge.embedding is required to ingest — see docs/06 §3.5')
  }
  const sources = selectSources(config.knowledge.sources, options.sourceIds)
  const progress = options.onProgress ?? (() => {})

  const previousManifest = await readManifest({
    ...(options.manifestDir === undefined ? {} : { dir: options.manifestDir }),
  })
  const manifest = options.force ? null : previousManifest
  const fingerprint = {
    model: embedding.model,
    ...(embedding.dimensions === undefined ? {} : { dimensions: embedding.dimensions }),
  }
  assertModelCompatible(manifest, fingerprint)
  const selectedIds = new Set(sources.map(idOf))
  const partialRun = sources.length < config.knowledge.sources.length
  if (
    options.force &&
    partialRun &&
    previousManifest !== null &&
    (previousManifest.model !== fingerprint.model ||
      previousManifest.dimensions !== fingerprint.dimensions)
  ) {
    throw new Error(
      'A model change requires rebuilding every source; rerun --force without --source.',
    )
  }
  const removedSources = partialRun
    ? []
    : Object.keys(previousManifest?.sources ?? {}).filter((id) => !selectedIds.has(id))

  // ── 1. fetch ─────────────────────────────────────────────────────────────
  const planned: PlannedSource[] = []
  for (const source of sources) {
    const id = idOf(source)
    const existing = manifest?.sources[id]
    // docs/06 §3.6 step 3: the manifest's validators make re-fetches
    // conditional, so an unchanged page costs a 304, not a download.
    const previous = new Map(
      Object.values(existing?.documents ?? {}).map((doc) => [
        doc.url,
        {
          contentHash: doc.contentHash,
          ...(doc.etag === undefined ? {} : { etag: doc.etag }),
          ...(doc.lastModified === undefined ? {} : { lastModified: doc.lastModified }),
        },
      ]),
    )
    const documents = await loadSource(source, config, options, previous)
    progress(`${source.type.padEnd(8)} ${labelOf(source)}: ${documents.length} documents`)

    const remaining = new Set(Object.keys(existing?.documents ?? {}))
    const plannedDocuments: PlannedDocument[] = []
    const removedChunkIdsForDocument: string[] = []

    for (const raw of documents) {
      remaining.delete(raw.url)
      const document: DocumentInput = {
        url: raw.url,
        title: raw.title,
        text: raw.text,
        headings: raw.headings,
        sourceId: id,
        sourceType: raw.sourceType,
        contentHash: raw.contentHash,
        updatedAt: raw.updatedAt === '' ? new Date().toISOString() : raw.updatedAt,
        ...(raw.lang === undefined ? {} : { lang: raw.lang }),
      }
      const before = existing?.documents[raw.url]
      const status: PlannedDocument['status'] =
        before === undefined
          ? 'added'
          : before.contentHash === raw.contentHash
            ? 'unchanged'
            : 'changed'
      const chunks = raw.notModified ? [] : chunkDocument(document, config.knowledge.chunk)
      const occurrences = new Map<string, number>()
      for (const chunk of chunks) {
        const content = JSON.stringify([chunk.headingPath, chunk.text])
        const occurrence = occurrences.get(content) ?? 0
        occurrences.set(content, occurrence + 1)
        chunk.id = chunkId(id, raw.url, content, occurrence)
      }
      if (before !== undefined && status === 'changed') {
        const nextIds = new Set(chunks.map((chunk) => chunk.id))
        removedChunkIdsForDocument.push(
          ...before.chunkHashes.filter((chunkId) => !nextIds.has(chunkId)),
        )
      }
      plannedDocuments.push({
        document,
        chunks,
        status,
        ...(raw.notModified && before ? { keptChunkHashes: before.chunkHashes } : {}),
        ...(raw.etag === undefined ? {} : { etag: raw.etag }),
        ...(raw.lastModified === undefined ? {} : { lastModified: raw.lastModified }),
      })
    }

    const removedChunkIds: string[] = [...removedChunkIdsForDocument]
    for (const url of remaining) {
      const before = existing?.documents[url]
      if (before === undefined) continue
      removedChunkIds.push(...before.chunkHashes)
    }
    planned.push({
      source,
      label: labelOf(source),
      documents: plannedDocuments,
      removedChunkIds,
      removedDocuments: remaining.size,
    })
  }

  const toEmbed: { document: DocumentInput; chunk: RawChunk }[] = []
  for (const plan of planned) {
    for (const doc of plan.documents) {
      if (doc.status === 'unchanged') continue
      const previousIds = new Set(
        manifest?.sources[idOf(plan.source)]?.documents[doc.document.url]?.chunkHashes ?? [],
      )
      for (const chunk of doc.chunks) {
        if (!previousIds.has(chunk.id)) toEmbed.push({ document: doc.document, chunk })
      }
    }
  }
  const chunksAffected =
    toEmbed.length +
    planned.reduce((total, plan) => total + plan.removedChunkIds.length, 0) +
    removedSources.reduce(
      (total, id) =>
        total +
        Object.values(previousManifest?.sources[id]?.documents ?? {}).reduce(
          (count, document) => count + document.chunkHashes.length,
          0,
        ),
      0,
    )
  const estimatedTokens = toEmbed.reduce((total, { chunk }) => total + chunk.tokens, 0)

  // ── 2. embed + write ─────────────────────────────────────────────────────
  let embeddingTokens = 0
  let embeddingBatches = 0
  let chunksToWrite: Chunk[] = []
  let store = options.store
  if (store === undefined && !options.dryRun) {
    store = await createNodeVectorStore(config.knowledge.store, {
      model: fingerprint.model,
      baseDir: config.$meta.baseDir ?? options.baseDir ?? null,
    })
  }

  try {
    if (!options.dryRun && toEmbed.length > 0 && store !== undefined) {
      const texts = toEmbed.map(({ chunk }) =>
        chunk.headingPath.length === 0
          ? chunk.text
          : `${chunk.headingPath.join(' > ')}\n\n${chunk.text}`,
      )
      const result =
        options.embedder !== undefined
          ? await options.embedder.embedBatch(texts)
          : await (async () => {
              const { model } = await createEmbeddingModel(embedding)
              return embedChunks(model, texts, {
                batchSize: embedding.batchSize,
                concurrency: options.concurrency ?? 4,
              })
            })()
      embeddingTokens = result.tokens
      embeddingBatches = Math.ceil(texts.length / embedding.batchSize)

      chunksToWrite = toEmbed.map((entry, index) => ({
        id: entry.chunk.id,
        text: entry.chunk.text,
        embedding: result.embeddings[index]!,
        metadata: {
          url: entry.document.url,
          title: entry.document.title,
          headingPath: entry.chunk.headingPath,
          sourceId: entry.document.sourceId,
          sourceType: entry.document.sourceType,
          contentHash: entry.document.contentHash,
          updatedAt: entry.document.updatedAt,
          tokens: entry.chunk.tokens,
          ordinal: entry.chunk.ordinal,
          ...(entry.document.lang === undefined ? {} : { lang: entry.document.lang }),
        },
      }))
    }
    if (!options.dryRun && store !== undefined) {
      const reordered: Chunk[][] = []
      if (!options.force && store.documentChunks !== undefined) {
        const newChunks = new Map(chunksToWrite.map((chunk) => [chunk.id, chunk]))
        for (const plan of planned) {
          for (const doc of plan.documents) {
            if (doc.status !== 'changed') continue
            const existing = (await store.documentChunks(doc.document.url)).filter(
              (chunk) => chunk.metadata.sourceId === doc.document.sourceId,
            )
            const oldChunks = new Map(existing.map((chunk) => [chunk.id, chunk]))
            const ordered = doc.chunks.map((chunk) => {
              const fresh = newChunks.get(chunk.id)
              if (fresh !== undefined) return fresh
              const kept = oldChunks.get(chunk.id)
              if (kept === undefined || kept.embedding.length === 0) return null
              return {
                ...kept,
                metadata: {
                  ...kept.metadata,
                  title: doc.document.title,
                  contentHash: doc.document.contentHash,
                  updatedAt: doc.document.updatedAt,
                  ordinal: chunk.ordinal,
                },
              }
            })
            if (existing.length === 0 || ordered.some((chunk) => chunk === null)) continue
            reordered.push(ordered as Chunk[])
            for (const chunk of doc.chunks) newChunks.delete(chunk.id)
          }
        }
        chunksToWrite = [...newChunks.values()]
      }
      if (options.force) {
        for (const plan of planned) await store.deleteBySource(idOf(plan.source))
      }
      for (const id of removedSources) await store.deleteBySource(id)
      for (const chunks of reordered) if (chunks.length > 0) await store.upsert(chunks)
      if (chunksToWrite.length > 0) await store.upsert(chunksToWrite)
      if (!options.force) {
        const removedIds = planned.flatMap((plan) => plan.removedChunkIds)
        if (removedIds.length > 0) await store.deleteByIds(removedIds)
      }
    }

    // ── 3. manifest ──────────────────────────────────────────────────────────
    if (!options.dryRun) {
      const next: Manifest = {
        version: 1,
        model: fingerprint.model,
        ...(embedding.dimensions === undefined ? {} : { dimensions: embedding.dimensions }),
        builtAt: new Date().toISOString(),
        sources: partialRun && previousManifest !== null ? { ...previousManifest.sources } : {},
      }
      for (const plan of planned) {
        const documents: Record<string, ManifestDocument> = {}
        for (const doc of plan.documents) {
          documents[doc.document.url] = {
            url: doc.document.url,
            contentHash: doc.document.contentHash,
            chunkHashes: doc.keptChunkHashes ?? doc.chunks.map((chunk) => chunk.id),
            ...(doc.etag === undefined ? {} : { etag: doc.etag }),
            ...(doc.lastModified === undefined ? {} : { lastModified: doc.lastModified }),
          }
        }
        next.sources[idOf(plan.source)] = {
          id: idOf(plan.source),
          type: plan.source.type,
          label: plan.label,
          documents,
        }
      }
      await writeManifest(next, {
        ...(options.manifestDir === undefined ? {} : { dir: options.manifestDir }),
      })
    }

    // ── 4. report ────────────────────────────────────────────────────────────
    const rate = dollarsPerMillionTokens(embedding.model)
    const tokens = embeddingTokens > 0 ? embeddingTokens : estimatedTokens
    const batches =
      embeddingBatches > 0
        ? embeddingBatches
        : toEmbed.length === 0
          ? 0
          : Math.ceil(toEmbed.length / embedding.batchSize)
    const stats = !options.dryRun && store !== undefined ? await store.stats() : null
    return {
      sources: planned.map((plan) => ({
        id: idOf(plan.source),
        type: plan.source.type,
        label: plan.label,
        found: plan.documents.length,
        unchanged: plan.documents.filter((doc) => doc.status === 'unchanged').length,
        changed: plan.documents.filter((doc) => doc.status === 'changed').length,
        added: plan.documents.filter((doc) => doc.status === 'added').length,
        removed: plan.removedDocuments,
      })),
      chunksAffected,
      embedding: {
        chunks: toEmbed.length,
        batches,
        tokens,
        estimatedUsd: rate === undefined ? 0 : (tokens / 1_000_000) * rate,
      },
      index:
        stats === null
          ? {
              chunks: planned.reduce(
                (total, plan) =>
                  total +
                  plan.documents.reduce(
                    (count, doc) => count + (doc.keptChunkHashes?.length ?? doc.chunks.length),
                    0,
                  ),
                0,
              ),
              documents: planned.reduce((total, plan) => total + plan.documents.length, 0),
              lastIndexed: new Date().toISOString(),
            }
          : {
              chunks: stats.chunks,
              documents: stats.documents,
              lastIndexed: stats.lastIndexed,
            },
      dryRun: options.dryRun === true,
    }
  } finally {
    // A CLI run owns the store it opened, including on embedding/write errors.
    // An injected store belongs to the caller and must remain usable.
    if (options.store === undefined) await store?.close()
  }
}

function selectSources(
  sources: readonly KnowledgeSource[],
  requested: string[] | undefined,
): KnowledgeSource[] {
  if (requested === undefined) return [...sources]
  const ids = new Set(requested)
  return sources.filter((source) => ids.has(idOf(source)))
}

function idOf(source: KnowledgeSource): string {
  return 'id' in source && source.id !== undefined ? source.id : source.type
}

function labelOf(source: KnowledgeSource): string {
  switch (source.type) {
    case 'sitemap':
    case 'crawl':
      return source.url
    case 'files':
      return source.glob
    case 'openapi':
      return source.url ?? source.path ?? ''
    case 'json':
      return source.path
    case 'text':
      return source.id
  }
}

async function loadSource(
  source: KnowledgeSource,
  config: ResolvedConfig,
  options: IngestOptions,
  previous: Map<string, { contentHash: string; etag?: string; lastModified?: string }>,
): Promise<RawDocument[]> {
  const http: HttpFetchOptions = {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  }
  switch (source.type) {
    case 'sitemap':
      return loadSitemap(source, config, { ...http, previous, onProgress: options.onProgress })
    case 'crawl':
      return loadCrawl(source, config, { ...http, onProgress: options.onProgress })
    case 'files':
      return loadFiles(source, config.knowledge.extract, {
        cwd: options.baseDir ?? config.$meta.baseDir ?? process.cwd(),
      })
    case 'openapi':
      return loadOpenApi(source, http)
    case 'text':
      return loadText(source)
    case 'json':
      return loadJson(source, {
        readFile: async (path: string) => {
          const fs = await import('node:fs/promises')
          const p = await import('node:path')
          return fs.readFile(
            p.resolve(options.baseDir ?? config.$meta.baseDir ?? process.cwd(), path),
            'utf8',
          )
        },
      })
  }
}

function chunkId(sourceId: string, url: string, content: string, occurrence: number): string {
  return sha256(JSON.stringify([sourceId, url, content, occurrence]))
}
