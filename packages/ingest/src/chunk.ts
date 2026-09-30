import type { Knowledge } from '@sitebot/config'
import { countTokens } from './tokens.js'
import { cosineSimilarity } from '@sitebot/core'

/**
 * Chunking — docs/06-knowledge.md §3.4.
 *
 * Three strategies, one output shape. `heading` splits at h1–h3 boundaries.
 * `fixed` walks token windows with overlap. `semantic` (the default) is
 * heading-aware first and fills sections to `maxTokens` with adjacent
 * paragraphs. `chunkSemanticDocument` embeds paragraph units before choosing
 * the largest adjacent cosine-distance gap in oversized sections.
 *
 * Every chunk carries `headingPath` — prepended to the text before embedding,
 * because a chunk's own prose usually does not name its section.
 */

export interface DocumentInput {
  url: string
  title: string
  text: string
  headings: { level: number; text: string; offset: number }[]
  sourceId: string
  sourceType: string
  contentHash: string
  updatedAt: string
  lang?: string
}

export interface RawChunk {
  /** Content-addressed id, set by the pipeline after chunking. */
  id: string
  text: string
  headingPath: string[]
  ordinal: number
  tokens: number
}

interface Section {
  headingPath: string[]
  paragraphs: string[]
}

function sections(document: DocumentInput, maxLevel: number): Section[] {
  const out: Section[] = []
  const path: string[] = []
  let current: Section = { headingPath: [], paragraphs: [] }
  out.push(current)

  const sorted = [...document.headings]
    .filter((heading) => heading.level <= maxLevel)
    .sort((a, b) => a.offset - b.offset)
  let cursor = 0
  for (const heading of sorted) {
    const before = document.text.slice(cursor, heading.offset).trim()
    if (before !== '') current.paragraphs.push(before)
    const level = heading.level
    path.length = level - 1
    path[level - 1] = heading.text
    if (level > 1 && path[0] === undefined) path[0] = document.title
    current = { headingPath: [...path.filter(Boolean)], paragraphs: [] }
    out.push(current)
    const headingLine = document.text.slice(heading.offset).split('\n', 1)[0] ?? ''
    cursor = heading.offset + headingLine.length
    // Skip markdown heading markers the extractor emitted, so the heading
    // text is not duplicated into the section body.
    const rest = document.text.slice(cursor)
    const marker = /^\s*\n?/.exec(rest)
    if (marker !== null) cursor += marker[0].length
  }
  const tail = document.text.slice(cursor).trim()
  if (tail !== '') {
    current.paragraphs.push(tail)
    out[Math.max(0, out.length - 1)] = current
  }
  return out.filter((section) => section.paragraphs.length > 0)
}

function* paragraphs(text: string): Generator<string> {
  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim()
    if (trimmed !== '') yield trimmed
  }
}

function packFixed(
  chunks: RawChunk[],
  text: string,
  headingPath: string[],
  options: Knowledge['chunk'],
  ordinal: { value: number },
): void {
  const blocks = [...paragraphs(text)]
  let buffer: string[] = []
  let tokens = 0
  const prefix = headingPath.join(' > ')
  const prefixTokens = prefix === '' ? 0 : countTokens(prefix) + 2
  const budget = options.maxTokens - prefixTokens

  const flush = (): void => {
    if (buffer.length === 0) return
    const body = buffer.join('\n\n')
    const chunkTokens = countTokens(body) + prefixTokens
    if (chunkTokens >= options.minTokens || chunks.length === 0) {
      chunks.push({
        id: '',
        text: body,
        headingPath: [...headingPath],
        ordinal: ordinal.value++,
        tokens: chunkTokens,
      })
    } else {
      // Undersized tail: merge it into the previous chunk rather than emit a
      // fragment retrieval will never score well on its own.
      const last = chunks[chunks.length - 1]!
      last.text = `${last.text}\n\n${body}`
      last.tokens += chunkTokens
    }
    buffer = []
    tokens = 0
  }

  for (const block of blocks) {
    const blockTokens = countTokens(block)
    if (blockTokens > budget) {
      flush()
      // A single paragraph over the budget gets hard-split at character level.
      chunkOversize(chunks, block, headingPath, options, ordinal)
      continue
    }
    if (tokens + blockTokens > budget && buffer.length > 0) {
      const flushed = [...buffer]
      flush()
      // Overlap: re-seed the buffer with a tail of the previous chunk.
      let overlap: string[] = []
      let overlapTokens = 0
      for (let index = flushed.length - 1; index >= 0; index--) {
        const candidate = flushed[index]!
        const candidateTokens = countTokens(candidate)
        if (overlapTokens + candidateTokens > options.overlapTokens) break
        overlapTokens += candidateTokens
        overlap = [candidate, ...overlap]
      }
      buffer = [...overlap]
      tokens = overlapTokens
    }
    buffer.push(block)
    tokens += blockTokens
  }
  flush()
}

function chunkOversize(
  chunks: RawChunk[],
  text: string,
  headingPath: string[],
  options: Knowledge['chunk'],
  ordinal: { value: number },
): void {
  const charsPerToken = 4 // matches estimateTokens, consistent by construction
  const window = (options.maxTokens - countTokens(headingPath.join(' > ')) - 2) * charsPerToken
  const step = Math.max(1, window - options.overlapTokens * charsPerToken)
  for (let start = 0; start < text.length; start += step) {
    const slice = text.slice(start, start + window).trim()
    if (slice === '') break
    chunks.push({
      id: '',
      text: slice,
      headingPath: [...headingPath],
      ordinal: ordinal.value++,
      tokens: countTokens(slice) + countTokens(headingPath.join(' > ')),
    })
    if (start + window >= text.length) break
  }
}

function packSemantic(
  chunks: RawChunk[],
  document: DocumentInput,
  options: Knowledge['chunk'],
  ordinal: { value: number },
): void {
  for (const section of sections(document, 3)) {
    const body = section.paragraphs.join('\n\n')
    const prefix = section.headingPath.join(' > ')
    const tokens = countTokens(prefix === '' ? body : `${prefix}\n\n${body}`)
    if (tokens <= options.maxTokens) {
      chunks.push({
        id: '',
        text: body,
        headingPath: section.headingPath,
        ordinal: ordinal.value++,
        tokens,
      })
      continue
    }
    throw new Error('Oversized semantic sections require chunkSemanticDocument and an embedder.')
  }
}

/**
 * Chunk one document. `headingPath` is part of every chunk's text input *at
 * embedding time* (the pipeline concatenates it), not of `RawChunk.text` —
 * keeping them separate is what lets `expandNeighbours` present clean prose.
 */
export function chunkDocument(document: DocumentInput, options: Knowledge['chunk']): RawChunk[] {
  const chunks: RawChunk[] = []
  const ordinal = { value: 0 }
  switch (options.strategy) {
    case 'fixed':
      packFixed(chunks, document.text, [], options, ordinal)
      break
    case 'heading': {
      for (const section of sections(document, 3)) {
        packFixed(chunks, section.paragraphs.join('\n\n'), section.headingPath, options, ordinal)
      }
      break
    }
    case 'semantic':
      packSemantic(chunks, document, options, ordinal)
      break
  }
  return chunks
}

export interface SemanticEmbedder {
  embedBatch(texts: string[]): Promise<{ embeddings: number[][]; tokens: number }>
}

/** Embedding-based semantic boundaries, without crossing heading sections. */
export async function chunkSemanticDocument(
  document: DocumentInput,
  options: Knowledge['chunk'],
  embedder: SemanticEmbedder,
): Promise<RawChunk[]> {
  const chunks: RawChunk[] = []
  for (const section of sections(document, 3)) {
    const prefix = section.headingPath.join(' > ')
    const tokenCount = (text: string) => countTokens(prefix === '' ? text : `${prefix}\n\n${text}`)
    const body = section.paragraphs.join('\n\n')
    const emit = (text: string) =>
      chunks.push({
        id: '',
        text,
        headingPath: [...section.headingPath],
        ordinal: chunks.length,
        tokens: tokenCount(text),
      })
    // Keep short sections intact, including short headings/tails; never lose prose.
    if (tokenCount(body) <= options.maxTokens) {
      emit(body)
      continue
    }
    const budget = options.maxTokens * 4 - (prefix === '' ? 0 : prefix.length + 2)
    if (budget < 1) throw new Error('chunk.maxTokens is too small for the heading prefix.')
    const units = [...paragraphs(body)].flatMap((paragraph) => {
      const parts: string[] = []
      // Pathological long paragraphs still need a hard upper bound.
      for (let offset = 0; offset < paragraph.length; offset += budget) {
        const part = paragraph.slice(offset, offset + budget).trim()
        if (part !== '') parts.push(part)
      }
      return parts
    })
    if (units.length === 1) {
      emit(units[0]!)
      continue
    }
    const result = await embedder.embedBatch(
      units.map((text) => (prefix === '' ? text : `${prefix}\n\n${text}`)),
    )
    const vectors = result.embeddings
    const dimensions = vectors[0]?.length ?? 0
    if (
      vectors.length !== units.length ||
      dimensions === 0 ||
      vectors.some(
        (vector) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new Error('Semantic embedder returned missing or invalid paragraph embeddings.')
    }
    const gaps = units
      .slice(1)
      .map((_, index) => 1 - cosineSimilarity(vectors[index]!, vectors[index + 1]!))
    const cumulative = [0]
    for (const unit of units) cumulative.push(cumulative[cumulative.length - 1]! + unit.length + 2)
    const rangeTokens = (start: number, end: number) =>
      Math.ceil(
        (cumulative[end]! - cumulative[start]! - 2 + (prefix === '' ? 0 : prefix.length + 2)) / 4,
      )
    // Iterative subdivision preserves source order and handles very long documents.
    const pending: [number, number][] = [[0, units.length]]
    while (pending.length > 0) {
      const [start, end] = pending.pop()!
      const text = units.slice(start, end).join('\n\n')
      if (tokenCount(text) <= options.maxTokens) {
        emit(text)
        continue
      }
      let split = -1
      let largest = -Infinity
      for (let index = start + 1; index < end; index++) {
        if (
          rangeTokens(start, index) < options.minTokens ||
          rangeTokens(index, end) < options.minTokens
        )
          continue
        const gap = gaps[index - 1]!
        if (
          gap > largest ||
          (gap === largest &&
            Math.abs(index - (start + end) / 2) < Math.abs(split - (start + end) / 2))
        ) {
          largest = gap
          split = index
        }
      }
      // minTokens is a preference; the hard maxTokens ceiling and no data loss win.
      if (split < 0) split = start + Math.max(1, Math.floor((end - start) / 2))
      pending.push([split, end], [start, split])
    }
  }
  // Add a bounded tail as context without moving the selected semantic boundary
  // or crossing a heading. Full chunks take precedence over overlap.
  for (let index = chunks.length - 1; index > 0 && options.overlapTokens > 0; index--) {
    const chunk = chunks[index]!
    const previous = chunks[index - 1]!
    if (JSON.stringify(chunk.headingPath) !== JSON.stringify(previous.headingPath)) continue
    const prefix = chunk.headingPath.join(' > ')
    const prefixChars = prefix === '' ? 0 : prefix.length + 2
    const available = options.maxTokens * 4 - prefixChars - chunk.text.length - 2
    const overlapChars = Math.min(options.overlapTokens * 4, available)
    if (overlapChars <= 0) continue
    const overlap = previous.text.slice(-overlapChars).trim()
    if (overlap === '') continue
    chunk.text = `${overlap}\n\n${chunk.text}`
    chunk.tokens = countTokens(prefix === '' ? chunk.text : `${prefix}\n\n${chunk.text}`)
  }
  return chunks
}
