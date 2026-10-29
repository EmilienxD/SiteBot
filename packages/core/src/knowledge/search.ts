import type { ResolvedConfig } from '@sitebot/config'
import { convertToModelMessages, type UIMessage } from 'ai'
import type { RequestContext } from '../types.js'
import { randomDelimiterId, untrustedBlock } from '../prompt/untrusted.js'
import { retrieve } from './retrieve.js'
import type { Citation, KnowledgeDeps, RetrievalHit } from './types.js'

/** At most this many short source records are carried from earlier turns. */
export const MAX_HISTORY_SOURCES = 32

function citationItems(message: UIMessage): Citation[] {
  if (message.role !== 'assistant') return []
  return message.parts.flatMap((part) => {
    if (part.type !== 'data-citations') return []
    const data = part.data as { items?: Citation[] } | undefined
    return Array.isArray(data?.items) ? data.items : []
  })
}

function numberOf(citation: Citation): number {
  const n = /^c([1-9]\d*)$/.exec(citation.id)?.[1]
  return n !== undefined && Number.isSafeInteger(Number(n)) ? Number(n) : 0
}

/** Stable numbers from trusted stored history; never infer sources from model text. */
export class KnowledgeEvidence {
  private readonly sources = new Map<number, Citation>()
  private readonly numbers = new Map<string, number>()
  private readonly current = new Set<number>()
  nextNumber = 1

  constructor(history: UIMessage[] = [], nextNumber: unknown = undefined) {
    if (typeof nextNumber === 'number' && Number.isSafeInteger(nextNumber) && nextNumber > 0)
      this.nextNumber = nextNumber
    // Newest source records win. Old per-answer records lack chunkId and
    // cannot safely be promoted into a conversation-wide numbering space.
    const ambiguous = new Set<number>()
    for (const message of [...history].reverse()) {
      for (const citation of citationItems(message).reverse()) {
        const n = numberOf(citation)
        this.nextNumber = Math.max(this.nextNumber, n + 1)
        if (!n || !citation.chunkId || ambiguous.has(n)) continue
        const key = JSON.stringify([citation.chunkId, citation.url, citation.lang])
        const previous = this.sources.get(n)
        if (previous && JSON.stringify([previous.chunkId, previous.url, previous.lang]) !== key) {
          // Concurrent/old store writes must never turn a conflicting number
          // into a silently misattributed source. A fresh search gets a new ID.
          this.sources.delete(n)
          this.numbers.delete(JSON.stringify([previous.chunkId, previous.url, previous.lang]))
          ambiguous.add(n)
          continue
        }
        if (
          this.sources.size >= MAX_HISTORY_SOURCES ||
          this.sources.has(n) ||
          this.numbers.has(key)
        )
          continue
        this.sources.set(n, { ...citation, snippet: citation.snippet.slice(0, 280) })
        this.numbers.set(key, n)
      }
    }
  }

  get citations(): Citation[] {
    return [...this.sources.entries()].sort(([a], [b]) => a - b).map(([, source]) => source)
  }

  /** Dropped model history must not silently supply a guessed citation. */
  retain(history: UIMessage[]): void {
    const visible = new Set(history.flatMap(citationItems).map((citation) => citation.id))
    for (const [n, citation] of this.sources) {
      if (!this.current.has(n) && !visible.has(citation.id)) {
        this.sources.delete(n)
        this.numbers.delete(JSON.stringify([citation.chunkId, citation.url, citation.lang]))
      }
    }
  }

  modelMessages(history: UIMessage[]) {
    // The SDK otherwise drops data parts, losing the source mapping for
    // inline-retrieval answers on the very next turn. Only assistant records
    // from the server history can supply reference data, never user parts.
    const parts = new Set(history.filter((m) => m.role === 'assistant').flatMap((m) => m.parts))
    return convertToModelMessages(history, {
      convertDataPart: (part) => {
        if (!parts.has(part) || part.type !== 'data-citations') return undefined
        const items = (part.data as { items: Citation[] }).items
        const sources = items.flatMap((item) => {
          const source = this.sources.get(numberOf(item))
          return source?.chunkId === item.chunkId &&
            source?.url === item.url &&
            source?.lang === item.lang
            ? [source]
            : []
        })
        if (!sources.length) return undefined
        return {
          type: 'text',
          text: untrustedBlock({
            tag: 'knowledge',
            source:
              'Previously retrieved source excerpts. Search again if these short excerpts do not support the answer.',
            content: sources
              .map((source) => `[${numberOf(source)}] ${JSON.stringify(source)}`)
              .join('\n'),
            delimiterId: randomDelimiterId(),
          }),
        }
      },
    })
  }

  add(hits: RetrievalHit[]): number[] {
    return hits.map((hit) => {
      const key = JSON.stringify([hit.id, hit.url, hit.lang])
      const existing = this.numbers.get(key)
      if (existing !== undefined) {
        this.current.add(existing)
        return existing
      }
      const n = this.nextNumber++
      this.numbers.set(key, n)
      this.current.add(n)
      this.sources.set(n, {
        id: `c${n}`,
        chunkId: hit.id,
        title: hit.title,
        url: hit.url,
        snippet: hit.text.slice(0, 280),
        score: hit.score,
        ...(hit.lang === undefined ? {} : { lang: hit.lang }),
      })
      return n
    })
  }
}

/** Shared by the automatic tool and explicitly configured builtin aliases. */
export async function searchKnowledge(
  input: unknown,
  config: ResolvedConfig,
  knowledge: KnowledgeDeps | null | undefined,
  ctx: RequestContext,
  evidence = new KnowledgeEvidence(),
): Promise<unknown> {
  if (knowledge?.store === undefined || knowledge.embedder === undefined) {
    return {
      results: [],
      note: 'Search is temporarily unavailable. Say you do not know if no other evidence covers the question.',
    }
  }
  const query =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>).query
      : undefined
  if (typeof query !== 'string' || query.trim() === '' || query.length > 4000) {
    return { error: 'invalid_input', issues: ['query must contain 1–4000 characters'] }
  }
  try {
    const result = await retrieve(
      { ...knowledge, store: knowledge.store, embedder: knowledge.embedder },
      query,
      config,
      ctx.locale,
    )
    const numbers = evidence.add(result.hits)
    const delimiterId = randomDelimiterId()
    return {
      results: result.hits.map((hit, index) => ({
        n: numbers[index],
        title: hit.title,
        url: hit.url,
        text: untrustedBlock({
          tag: 'knowledge',
          source: 'The text below comes from indexed public documentation.',
          content: hit.text,
          delimiterId,
        }),
        score: hit.score,
        ...(hit.lang === undefined ? {} : { lang: hit.lang }),
      })),
      ...(result.hits.length === 0
        ? { note: 'No relevant documentation found. Say so rather than guessing.' }
        : {}),
    }
  } catch (error) {
    ctx.logger.warn('knowledge retrieval failed', { error })
    return {
      results: [],
      note: 'Search is temporarily unavailable. Answer from other evidence or say you do not know.',
    }
  }
}
