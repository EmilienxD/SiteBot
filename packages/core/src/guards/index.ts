import type { ResolvedConfig } from '@sitebot/config'
import type { UIMessage } from 'ai'
import { lastUserMessage } from '../session/history.js'
import type { BudgetTracker, Identity, Logger } from '../types.js'
import { resolveIdentity, type TokenVerifier } from './auth.js'
import { checkPublicKey } from './key.js'
import { checkOrigin } from './origin.js'
import { checkRateLimit, type RateLimitStore } from './rate-limit.js'
import { checkBlockedPatterns, checkMessageLength, compileBlockedPatterns } from './request.js'

export * from './auth.js'
export * from './budget.js'
export * from './key.js'
export * from './origin.js'
export * from './pii.js'
export * from './rate-limit.js'
export * from './request.js'

export interface GuardDeps {
  rateLimitStore: RateLimitStore
  budget?: BudgetTracker
  verifier?: TokenVerifier
  logger: Logger
}

export interface GuardInput {
  config: ResolvedConfig
  origin: string | null
  key: string | null
  ip: string | null
  sessionId: string
  messages: readonly UIMessage[]
  token: string | null
  selfOrigin: string | null
}

export interface GuardResult {
  identity: Identity | null
  budget: 'ok' | 'degrade' | 'block'
  allowOrigin: string | null
}

/** Fixed order: origin, key, rate limit, budget, auth, message limits. */
export async function runGuards(input: GuardInput, deps: GuardDeps): Promise<GuardResult> {
  const { security, prompt } = input.config

  const { allowOrigin } = checkOrigin({
    origin: input.origin,
    allowedOrigins: security.allowedOrigins,
    selfOrigin: input.selfOrigin,
  })

  checkPublicKey(input.key, security.publicKey)

  await checkRateLimit({
    store: deps.rateLimitStore,
    sessionId: input.sessionId,
    ip: input.ip,
    perSession: security.rateLimit.perSession,
    perIp: security.rateLimit.perIp,
  })

  const latest = lastUserMessage(input.messages)
  const estimatedTokens =
    input.config.backend.maxOutputTokens +
    (latest === null ? 0 : Math.ceil(JSON.stringify(latest.parts).length / 4))
  const budget =
    deps.budget === undefined
      ? 'ok'
      : await deps.budget.check(
          estimatedTokens,
          `${input.config.backend.provider}:${input.config.backend.model}`,
        )

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

  if (latest !== null) {
    checkMessageLength(latest, prompt.guardrails.maxUserMessageChars)
    checkBlockedPatterns(latest, compileBlockedPatterns(security.blockedPatterns))
  }

  return { identity, budget, allowOrigin }
}
