/**
 * `sitebot ingest` — build or refresh the knowledge index.
 *
 * docs/06-knowledge.md §5. This command owns argument parsing, config
 * resolution, the preflight checks, and the report; the crawl → extract →
 * chunk → embed → write pipeline itself belongs to `@sitebot/ingest`, which is
 * layer 3 and importable directly so a CI job can do the same work without the
 * CLI (docs/01-architecture.md §2).
 */

import { runIngest as runIngestPipeline, type IngestOptions, type IngestRun } from '@sitebot/ingest'
import type { KnowledgeSource, ResolvedConfig } from '@sitebot/config'
import type { FlagSpecs } from '../args.js'
import { formatCount, type Ui } from '../terminal.js'
import {
  loadForCommand,
  reportConfigError,
  type CommandContext,
  type CommandResult,
} from './context.js'

export type { IngestOptions, IngestRun }

export const INGEST_FLAGS: FlagSpecs = {
  source: {
    type: 'string',
    summary: 'Only ingest the source with this id. Repeatable via commas.',
    placeholder: '<id>',
  },
  force: {
    type: 'boolean',
    summary: 'Re-embed everything, ignoring the manifest. Needed after a model change.',
  },
  'dry-run': {
    type: 'boolean',
    summary: 'Report what would change and the estimated cost. Writes nothing, spends nothing.',
  },
  concurrency: { type: 'number', summary: 'Parallel fetches. Default 4.', placeholder: '<n>' },
}

export async function runIngestCommand(context: CommandContext): Promise<CommandResult> {
  const { ui, flags } = context

  let loaded
  try {
    loaded = await loadForCommand(context)
  } catch (error) {
    return { exitCode: reportConfigError(ui, error) }
  }

  const { config } = loaded
  const { knowledge } = config

  if (knowledge.sources.length === 0) {
    ui.fatal(
      'No knowledge sources are configured, so there is nothing to ingest.',
      'Add a `knowledge.sources` entry — see docs/06-knowledge.md §3. Layers 1 and 2 (siteContext and page context) work without it.',
    )
    return { exitCode: 1 }
  }

  // The schema already rejects sources-without-embedding (cross-field rule 5),
  // so reaching here without one means the config was built in code.
  if (knowledge.embedding === undefined) {
    ui.fatal(
      'knowledge.embedding is required to ingest.',
      'Set knowledge.embedding.provider and .model.',
    )
    return { exitCode: 1 }
  }

  const requested = parseSourceIds(flags['source'])
  const selected = selectSources(knowledge.sources, requested)
  if (typeof selected === 'string') {
    ui.fatal(selected, `Configured ids: ${knowledge.sources.map(sourceId).join(', ')}.`)
    return { exitCode: 1 }
  }

  const dryRun = flags['dry-run'] === true
  printPlan(ui, config, selected, dryRun)

  const options: IngestOptions = {
    sourceIds: selected.map(sourceId),
    force: flags['force'] === true,
    dryRun,
    ...(typeof flags['concurrency'] === 'number' ? { concurrency: flags['concurrency'] } : {}),
    onProgress: (message) => ui.step(message),
  }

  try {
    const run = await runIngestPipeline(config, options)
    printRun(ui, run)
    return { exitCode: 0 }
  } catch (error) {
    ui.fatal(error instanceof Error ? error.message : String(error))
    return { exitCode: 1 }
  }
}

function printPlan(
  ui: Ui,
  config: ResolvedConfig,
  sources: KnowledgeSource[],
  dryRun: boolean,
): void {
  const { store, embedding, chunk } = config.knowledge
  ui.line()
  ui.success(`Loaded ${config.$meta.sourcePath ?? '(inline config)'}`)
  ui.detail('Store:', storeLabel(store))
  if (embedding !== undefined) {
    const dimensions = embedding.dimensions === undefined ? '' : ` (${embedding.dimensions}d)`
    ui.detail('Embedding:', `${embedding.provider}/${embedding.model}${dimensions}`)
  }
  ui.detail('Chunking:', `${chunk.strategy}, max ${chunk.maxTokens} tokens`)
  if (dryRun) ui.detail('Mode:', 'dry run — nothing will be written or spent')

  ui.line()
  for (const source of sources) ui.info(`${source.type.padEnd(8)} ${sourceLabel(source)}`)
}

function printRun(ui: Ui, run: IngestRun): void {
  ui.line()
  for (const source of run.sources) {
    ui.info(`${source.type.padEnd(8)} ${source.label}`)
    ui.step(`${formatCount(source.found)} found`)
    ui.step(
      `${formatCount(source.unchanged)} unchanged · ${formatCount(source.changed)} changed · ` +
        `${formatCount(source.added)} new · ${formatCount(source.removed)} removed`,
    )
  }

  const { chunks, batches, tokens, estimatedUsd } = run.embedding
  ui.line()
  ui.detail('Chunking …', `${formatCount(run.chunksAffected)} chunks affected`)
  ui.detail(
    'Embedding …',
    `${formatCount(chunks)} chunks (${batches} ${batches === 1 ? 'batch' : 'batches'}) · ` +
      `~${formatTokens(tokens)} tokens · ≈ $${estimatedUsd.toFixed(3)}`,
  )
  ui.detail('Writing …', run.dryRun ? 'skipped (dry run)' : 'done')

  ui.line()
  ui.success(
    `Index: ${formatCount(run.index.chunks)} chunks across ${formatCount(run.index.documents)} documents`,
  )
  ui.detail('Last indexed', run.index.lastIndexed)
}

/** Sources have optional ids; fall back to the type so selection always works. */
export function sourceId(source: KnowledgeSource): string {
  return 'id' in source && source.id !== undefined ? source.id : source.type
}

function sourceLabel(source: KnowledgeSource): string {
  switch (source.type) {
    case 'sitemap':
    case 'crawl':
      return source.url
    case 'files':
      return source.glob
    case 'openapi':
      return source.url ?? source.path ?? '(unspecified)'
    case 'json':
      return source.path
    case 'text':
      return source.id
  }
}

function storeLabel(store: ResolvedConfig['knowledge']['store']): string {
  switch (store.type) {
    case 'sqlite':
      return `sqlite (${store.path})`
    case 'memory':
      return store.path === undefined ? 'memory (not persisted)' : `memory (${store.path})`
    case 'pgvector':
      return `pgvector (table ${store.table})`
    case 'upstash':
      return 'upstash'
    case 'custom':
      return `custom (${store.module})`
  }
}

function parseSourceIds(flag: unknown): string[] | null {
  if (typeof flag !== 'string' || flag === '') return null
  return flag
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function selectSources(
  sources: readonly KnowledgeSource[],
  requested: string[] | null,
): KnowledgeSource[] | string {
  if (requested === null) return [...sources]

  const selected: KnowledgeSource[] = []
  for (const id of requested) {
    const match = sources.filter((source) => sourceId(source) === id)
    if (match.length === 0) return `No knowledge source with id "${id}".`
    selected.push(...match)
  }
  return selected
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}
