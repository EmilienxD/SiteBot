import type { Auth } from '@sitebot/config'
import { EngineError } from '../stream/errors.js'
import type { Identity } from '../types.js'

/**
 * Identity — docs/08-security.md §3.
 *
 * Full JWT verification (HS256 + JWKS, all seven rules) is Phase 8. What is
 * here now is the *shape*: verification is an injected seam, and a token that
 * nothing verified produces `null` identity — never a decoded one.
 *
 * That last point is the whole reason this file exists this early. Decoding an
 * unverified JWT "just to get the sub while we wait for Phase 8" would make
 * every `scope: authenticated` tool trivially forgeable, and it is exactly the
 * kind of temporary shortcut that outlives the phase that introduced it.
 */

export interface TokenVerifier {
  /** Resolve verified claims, or throw. Never returns unverified claims. */
  verify(token: string, auth: Auth): Promise<Identity>
}

export interface AuthCheckInput {
  token: string | null | undefined
  auth: Auth
  verifier?: TokenVerifier
  /** Warned through, once, when a token arrives with no verifier configured. */
  onUnverifiable?: () => void
}

export async function resolveIdentity(input: AuthCheckInput): Promise<Identity | null> {
  const { auth, token } = input
  const present = typeof token === 'string' && token !== ''

  if (auth.mode === 'none') {
    // A token sent to a deployment that does not do auth is ignored rather than
    // rejected: the host site may embed one widget config across many pages.
    return null
  }

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
        detail: 'auth.mode is required but no JWT verifier is installed (Phase 8)',
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
    // `optional`: a bad token downgrades to anonymous rather than failing the
    // conversation. `<tool_policy>` then tells the model why the authenticated
    // tools are missing, which is a better user experience than a 401 on a
    // marketing page.
    return null
  }
}
