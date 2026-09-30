// A deterministic stand-in for a developer-supplied local cross-encoder.
export default function createReranker() {
  return {
    async rerank(_query, documents) {
      return documents.map((_, index) => ({ index, score: 1 / (index + 1) }))
    },
  }
}
