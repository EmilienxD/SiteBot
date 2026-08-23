import type { QueryEmbedder } from '../src/knowledge/types.js'

/**
 * A deterministic, offline stand-in for an embedding provider.
 *
 * docs/09 hard rule: no test in the default CI pipeline makes a real network
 * call to a provider. This is TF-IDF over a hashed vocabulary, L2-normalised so
 * the store's cosine similarity lands in [0, 1] — the same arithmetic a real
 * embedder feeds, from lexical overlap rather than learned semantics.
 *
 * What that buys and what it does not: the golden set built on it measures
 * *retrieval* — chunking, scoring, dedupe, topK — and will fail loudly if any
 * of those regress. It says nothing about how well a real embedding model
 * generalises across vocabulary, so golden queries are phrased in the site's
 * own words on purpose.
 */

const DIMENSIONS = 4096

/**
 * High-frequency words carry no retrieval signal and, hashed into a shared
 * vocabulary, actively add collision noise.
 */
const STOPWORDS = new Set([
  'a',
  'about',
  'after',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'before',
  'but',
  'by',
  'can',
  'do',
  'does',
  'each',
  'every',
  'for',
  'from',
  'get',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'more',
  'most',
  'my',
  'no',
  'not',
  'of',
  'on',
  'one',
  'or',
  'our',
  'out',
  'over',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'up',
  'us',
  'use',
  'used',
  'was',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
])

/** Crude suffix stripping — enough that "shipments" and "shipment" agree. */
function stem(word: string): string {
  for (const suffix of ['ing', 'ies', 'es', 'ed', 's']) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return suffix === 'ies' ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length)
    }
  }
  return word
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem)
}

/** FNV-1a, so the vocabulary bucket for a token is stable across runs. */
function bucket(token: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % DIMENSIONS
}

export interface LexicalEmbedder extends QueryEmbedder {
  embedSync(text: string): number[]
  /** Embedding calls made, so a test can assert none were needed. */
  readonly calls: string[]
}

/**
 * Build an embedder whose IDF weights come from `corpus`. A real model's
 * weights are likewise fixed before any query is embedded, so the query path
 * stays honest: it never sees the corpus, only the weights.
 */
export function lexicalEmbedder(corpus: readonly string[]): LexicalEmbedder {
  const documentFrequency = new Map<string, number>()
  for (const document of corpus) {
    for (const token of new Set(tokenize(document))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }
  const total = corpus.length

  const idf = (token: string): number =>
    Math.log(1 + total / (1 + (documentFrequency.get(token) ?? 0)))

  const calls: string[] = []

  const embedSync = (text: string): number[] => {
    const vector = new Array<number>(DIMENSIONS).fill(0)
    const counts = new Map<string, number>()
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1)

    for (const [token, count] of counts) {
      // Sublinear tf: a word repeated ten times is not ten times the evidence.
      vector[bucket(token)]! += (1 + Math.log(count)) * idf(token)
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    return norm === 0 ? vector : vector.map((value) => value / norm)
  }

  return {
    modelId: 'lexical-tfidf-stub',
    calls,
    embedSync,
    async embed(text: string) {
      calls.push(text)
      return { embedding: embedSync(text), tokens: tokenize(text).length }
    },
  }
}
