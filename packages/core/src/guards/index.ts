import type { UIMessage } from 'ai'
import type { ResolvedConfig } from '@sitebot/config'
import type { Identity, Logger } from '../types.js'
import { resolveIdentity, type TokenVerifier } from './auth.js'
import { checkPublicKey } from './key.js'
import { checkOrigin } from './origin.js'
import { checkRateLimit, type RateLimitStore } from './rate-limit.js'
import { lastUserMessage } from '../session/history.js'
import { checkBlockedPatterns, checkMessageLength, compileBlockedPatterns } from './request.js'

export * from './auth.js'
export * from './budget.js'
export * from './key.js'
export * from './origin.js'
export * from './rate-limit.js'
export * from './request.js'

/**
 * The guard pipeline — docs/01-architecture.md §4 step 5.
 *
 * The order is fixed by docs/04-providers-and-engine.md §8:
 *
 *     origin → key → rate limit → budget → auth → size
 *
 * "Cheapest and most-certain rejections first." Origin and key are string
 * comparisons; the rate limit is one store round-trip; auth may hit a JWKS
 * endpoint over the network. Running auth before the rate limit would let an
 * attacker spend our JWKS budget for free, and running any of it after the
 * model call would defeat the point entirely.
 *
 * `runGuards` is therefore a single function with the order written out once,
 * rather than a chain each caller assembles — an ordering invariant that lives
 * in a call site is one refactor away from being wrong.
 */

export interface GuardDeps {
  rateLimitStore: RateLimitStore
  verifier?: TokenVerifier
  logger: Logger
}

export interface GuardInput {
  config: ResolvedConfig
  /** The `Origin` header, verbatim. */
  origin: string | null
  /** The `X-SiteBot-Key` header. */
  key: string | null
  /** Resolved per `security.trustProxy`; null when unknown. */
  ip: string | null
  sessionId: string
  messages: readonly UIMessage[]
  /** The `auth` field of the body, or a bearer token from the header. */
  token: string | null
  /** This deployment's own origin, from the request URL. */
  selfOrigin: string | null
}

export interface GuardResult {
  identity: Identity | null
  /** Echoed into `Access-Control-Allow-Origin`; null means do not send one. */
  allowOrigin: string | null
}

export async function runGuards(input: GuardInput, deps: GuardDeps): Promise<GuardResult> {
  const { security, prompt } = input.config

  // 1 — origin
  const { allowOrigin } = checkOrigin({
    origin: input.origin,
    allowedOrigins: security.allowedOrigins,
    selfOrigin: input.selfOrigin,
  })

  // 2 — key
  checkPublicKey(input.key, security.publicKey)

  // 3 — rate limit
  await checkRateLimit({
    store: deps.rateLimitStore,
    sessionId: input.sessionId,
    ip: input.ip,
    perSession: security.rateLimit.perSession,
    perIp: security.rateLimit.perIp,
  })

  // 4 — budget. Checked per-request in Phase 8; the tracker lives on
  // RequestContext and is consulted by the engine right before the model call.

  // 5 — auth
  const identity = await resolveIdentity({
    token: input.token,
    auth: security.auth,
    verifier: deps.verifier,
    onUnverifiable: () => {
      deps.logger.warn(
        'an auth token was presented but no JWT verifier is installed; treating the request as anonymous',
      )
    },
  })

  // 6 — size. Only the last user message is inspected, because it is the only
  // message from the body that the engine will trust (docs/08 §6).
  const latest = lastUserMessage(input.messages)
  if (latest !== null) {
    checkMessageLength(latest, prompt.guardrails.maxUserMessageChars)
    checkBlockedPatterns(latest, compileBlockedPatterns(security.blockedPatterns))
  }

  return { identity, allowOrigin }
}
