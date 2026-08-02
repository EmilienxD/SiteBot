import { EngineError } from '../stream/errors.js'

/**
 * `X-SiteBot-Key` — docs/03-protocol.md §2, docs/08-security.md §2.
 *
 * The public key is **not** a secret and grants nothing on its own; it names a
 * deployment so that CORS, analytics and multi-tenant routing have something to
 * key on. It is checked because a mismatch almost always means a stale embed on
 * someone's page, and a clear 403 is a better answer than a confusing one.
 */

/**
 * Length-invariant comparison. The key is public, so this is not defending a
 * secret — it keeps the comparison from becoming a timing oracle if someone
 * later reuses this helper for something that is one.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

/**
 * No configured `publicKey` means the check does not apply — most single-site
 * deployments never set one, and inventing a requirement they did not ask for
 * would just be a failure mode.
 */
export function checkPublicKey(presented: string | null | undefined, configured?: string): void {
  if (configured === undefined || configured === '') return
  if (presented == null || !safeEqual(presented, configured)) {
    throw new EngineError('invalid_key', {
      detail: presented == null ? 'no X-SiteBot-Key presented' : 'X-SiteBot-Key does not match',
    })
  }
}
