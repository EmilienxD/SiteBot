/**
 * Token counting for chunking.
 *
 * A real tokenizer (tiktoken and friends) weighs more than the entire ingest
 * package; `estimateTokens` in core is the repo's existing approximation and
 * chunking only needs consistency, not exactness — the `maxTokens` ceiling
 * is a budget, not a wire format. Using the same helper means ingest and
 * query-time truncation agree on the number.
 */
export { estimateTokens as countTokens } from '@sitebot/core'
