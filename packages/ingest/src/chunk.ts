import type { Knowledge } from '@sitebot/config'
import { countTokens } from './tokens.js'

/**
 * Chunking — docs/06-knowledge.md §3.4.
 *
 * Three strategies, one output shape. `heading` splits at h1–h3 boundaries.
 * `fixed` walks token windows with overlap. `semantic` (the default) is
 * heading-aware first and fills sections to `maxTokens` with adjacent
 * paragraphs; the embedding-distance split the doc describes as a refinement
 * needs embeddings *before* chunking (docs/09 open question 4) and ships only
 * if it measures better — today an oversized semantic section degrades to
 * `fixed`, the same escape `heading` uses.
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
  /** sha256(sourceId + url + ordinal) — set by the pipeline, not the chunker. */
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
    cursor = heading.offset + heading.text.length
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
    const prefixTokens = prefix === '' ? 0 : countTokens(prefix) + 2
    if (countTokens(body) + prefixTokens <= options.maxTokens) {
      if (countTokens(body) + prefixTokens >= options.minTokens) {
        chunks.push({
          id: '',
          text: body,
          headingPath: section.headingPath,
          ordinal: ordinal.value++,
          tokens: countTokens(body) + prefixTokens,
        })
      }
      continue
    }
    // Semantic section too large: head-aware packing of its paragraphs; the
    // hard character-level fallback inside packFixed covers a pathological
    // single paragraph.
    packFixed(chunks, body, section.headingPath, options, ordinal)
  }
}

/**
 * Chunk one document. `headingPath` is part of every chunk's text input *at
 * embedding time* (the pipeline concatenates it), not of `RawChunk.text` —
 * keeping them separate is what lets `expandNeighbours` present clean prose.
 */
export function chunkDocument(
  document: DocumentInput,
  options: Knowledge['chunk'],
): RawChunk[] {
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
