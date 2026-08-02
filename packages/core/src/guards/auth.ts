import type { Auth } from '@sitebot/config'
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import { EngineError } from '../stream/errors.js'
import type { Identity } from '../types.js'

/** Identity and authentication - docs/08-security.md section 3. */

export interface TokenVerifier {
  /** Resolve verified claims, or throw. Never returns unverified claims. */
  verify(token: string, auth: Auth): Promise<Identity>
}

export interface JwtVerifierOptions {
  fetchImpl?: typeof fetch
  /** Seconds since the Unix epoch. */
  now?: () => number
}

/** Standards-compliant HS* and RS/ES JWKS verification. */
export function createJwtVerifier(options: JwtVerifierOptions = {}): TokenVerifier {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const jwks = new Map<string, JWTVerifyGetKey>()

  return {
    async verify(token, auth) {
      const jwt = auth.jwt
      if (jwt === undefined) throw new Error('JWT configuration is missing')

      const current = now()
      const verified = await jwtVerify<JWTPayload>(
        token,
        verificationKey(jwt, jwks, options.fetchImpl),
        {
          algorithms: [jwt.algorithm],
          ...(jwt.issuer === undefined ? {} : { issuer: jwt.issuer }),
          ...(jwt.audience === undefined ? {} : { audience: jwt.audience }),
          requiredClaims: ['exp', 'iat'],
          clockTolerance: jwt.clockToleranceSeconds,
          currentDate: new Date(current * 1000),
        },
      )

      const issuedAt = verified.payload.iat
      const expiresAt = verified.payload.exp
      if (issuedAt === undefined || expiresAt === undefined) {
        throw new Error('JWT must contain iat and exp claims')
      }
      const tolerance = jwt.clockToleranceSeconds
      if (current - issuedAt > jwt.maxTokenAgeSeconds + tolerance) {
        throw new Error('JWT exceeds maxTokenAgeSeconds')
      }
      if (expiresAt - issuedAt > jwt.maxTokenAgeSeconds + tolerance) {
        throw new Error('JWT exp exceeds maxTokenAgeSeconds')
      }

      return mapClaims(verified.payload, jwt.claimsMap)
    },
  }
}

function verificationKey(
  jwt: NonNullable<Auth['jwt']>,
  cache: Map<string, JWTVerifyGetKey>,
  fetchImpl?: typeof fetch,
): Uint8Array | JWTVerifyGetKey {
  if (jwt.secret !== undefined) return new TextEncoder().encode(jwt.secret)
  if (jwt.jwksUrl === undefined) throw new Error('JWT needs a secret or jwksUrl')

  const cached = cache.get(jwt.jwksUrl)
  if (cached !== undefined) return cached
  const resolver = createRemoteJWKSet(new URL(jwt.jwksUrl), {
    ...(fetchImpl === undefined ? {} : { [customFetch]: fetchImpl }),
  })
  cache.set(jwt.jwksUrl, resolver)
  return resolver
}

function mapClaims(payload: JWTPayload, claimsMap: Record<string, string>): Identity {
  const identity: Record<string, unknown> = {}
  for (const [destination, source] of Object.entries(claimsMap)) {
    const value = source.split('.').reduce<unknown>((current, key) => {
      if (typeof current !== 'object' || current === null) return undefined
      return (current as Record<string, unknown>)[key]
    }, payload)
    if (value !== undefined) identity[destination] = value
  }

  const subject = identity.sub ?? payload.sub
  if (typeof subject !== 'string' || subject === '') {
    throw new Error('JWT must contain a string sub claim or map one to identity.sub')
  }
  identity.sub = subject
  return identity as Identity
}

export interface AuthCheckInput {
  token: string | null | undefined
  auth: Auth
  verifier?: TokenVerifier
  onUnverifiable?: () => void
}

export async function resolveIdentity(input: AuthCheckInput): Promise<Identity | null> {
  const { auth, token } = input
  const present = typeof token === 'string' && token !== ''

  if (auth.mode === 'none') return null

  if (!present) {
    if (auth.mode === 'required') {
      throw new EngineError('auth_required', {
        detail: 'auth.mode is required and no token was presented',
      })
    }
    return null
  }

  if (input.verifier === undefined) {
    input.onUnverifiable?.()
    if (auth.mode === 'required') {
      throw new EngineError('not_ready', {
        message: 'This assistant is not configured correctly for this site.',
        detail: 'auth.mode is required but no JWT verifier is installed',
      })
    }
    return null
  }

  try {
    return await input.verifier.verify(token, auth)
  } catch (error) {
    if (auth.mode === 'required') {
      throw new EngineError('auth_required', {
        detail: error instanceof Error ? error.message : 'token verification failed',
        cause: error,
      })
    }
    return null
  }
}
