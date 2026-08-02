import { describe, expect, it, vi } from 'vitest'
import { EngineError } from '../stream/errors.js'
import { silentLogger } from '../telemetry/logger.js'
import { testConfig, userMessage } from '../../test/helpers.js'
import { runGuards } from './index.js'
import { checkPublicKey, safeEqual } from './key.js'
import { checkOrigin, matchesOrigin, normaliseOrigin } from './origin.js'
import {
  MemoryRateLimitStore,
  checkRateLimit,
  parseRateLimitRule,
  unlimitedRateLimitStore,
} from './rate-limit.js'
import {
  checkBlockedPatterns,
  checkContentLength,
  checkMessageLength,
  compileBlockedPatterns,
  isValidSessionId,
  lastUserMessage,
  parseChatRequest,
} from './request.js'

const SESSION = 's_01J9X8Y7Z6ABCDEFGHJKMNPQRS'

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    return error instanceof EngineError ? error.code : 'not-an-EngineError'
  }
  return 'no-error'
}

const asyncCodeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
  } catch (error) {
    return error instanceof EngineError ? error.code : 'not-an-EngineError'
  }
  return 'no-error'
}

describe('origin (docs/08 §7)', () => {
  it('normalises to scheme://host:port and rejects opaque origins', () => {
    expect(normaliseOrigin('https://Acme.com/orders')).toBe('https://acme.com')
    expect(normaliseOrigin('null')).toBeNull()
    expect(normaliseOrigin('  ')).toBeNull()
    expect(normaliseOrigin('not a url')).toBeNull()
  })

  it('matches exactly, and one wildcard level only', () => {
    expect(matchesOrigin('https://acme.com', 'https://acme.com')).toBe(true)
    expect(matchesOrigin('https://app.acme.com', 'https://*.acme.com')).toBe(true)
    // Two levels deep, the bare domain, and a scheme mismatch all miss.
    expect(matchesOrigin('https://a.b.acme.com', 'https://*.acme.com')).toBe(false)
    expect(matchesOrigin('https://acme.com', 'https://*.acme.com')).toBe(false)
    expect(matchesOrigin('http://app.acme.com', 'https://*.acme.com')).toBe(false)
    // The suffix must be a whole label boundary, not a string suffix.
    expect(matchesOrigin('https://evilacme.com', 'https://*.acme.com')).toBe(false)
  })

  it('empty allowedOrigins means same-origin only', () => {
    expect(
      checkOrigin({
        origin: 'https://acme.com',
        allowedOrigins: [],
        selfOrigin: 'https://acme.com',
      }).allowOrigin,
    ).toBe('https://acme.com')

    expect(
      codeOf(() =>
        checkOrigin({
          origin: 'https://evil.com',
          allowedOrigins: [],
          selfOrigin: 'https://acme.com',
        }),
      ),
    ).toBe('origin_denied')
  })

  it('allows a request with no Origin header, echoing nothing back', () => {
    // curl and server-to-server callers omit it; CORS is a browser control, so
    // its absence must not unlock anything either.
    expect(checkOrigin({ origin: null, allowedOrigins: [] }).allowOrigin).toBeNull()
  })
})

describe('public key', () => {
  it('is skipped when unconfigured, and enforced when set', () => {
    expect(() => {
      checkPublicKey(null, undefined)
    }).not.toThrow()
    expect(
      codeOf(() => {
        checkPublicKey(null, 'pk_live_a1b2c3')
      }),
    ).toBe('invalid_key')
    expect(
      codeOf(() => {
        checkPublicKey('pk_live_wrong', 'pk_live_a1b2c3')
      }),
    ).toBe('invalid_key')
    expect(() => {
      checkPublicKey('pk_live_a1b2c3', 'pk_live_a1b2c3')
    }).not.toThrow()
  })

  it('compares without short-circuiting on content', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('rate limit (docs/08 §7)', () => {
  it('parses the config rule format', () => {
    expect(parseRateLimitRule('30/5m')).toEqual({ limit: 30, windowMs: 300_000 })
    expect(parseRateLimitRule('100/1h')).toEqual({ limit: 100, windowMs: 3_600_000 })
    expect(parseRateLimitRule('5/10s')).toEqual({ limit: 5, windowMs: 10_000 })
  })

  it('slides: hits expire out of the window', async () => {
    let clock = 1_000_000
    const store = new MemoryRateLimitStore({ now: () => clock })
    const rule = { limit: 2, windowMs: 1_000 }

    expect((await store.hit('k', rule)).allowed).toBe(true)
    expect((await store.hit('k', rule)).allowed).toBe(true)

    const blocked = await store.hit('k', rule)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBe(1)

    clock += 1_001
    expect((await store.hit('k', rule)).allowed).toBe(true)
  })

  it('reports the session limit before the IP limit', async () => {
    const store = new MemoryRateLimitStore()
    const check = () =>
      checkRateLimit({
        store,
        sessionId: SESSION,
        ip: '203.0.113.5',
        perSession: '1/1h',
        perIp: '100/1h',
      })

    await check()
    const error = await check().then(
      () => null,
      (thrown: unknown) => thrown as EngineError,
    )
    expect(error?.code).toBe('rate_limited')
    expect(error?.detail).toContain('session:')
    expect(error?.headers['retry-after']).toBeDefined()
  })

  it('skips the IP rule when the IP is unknown', async () => {
    const store = new MemoryRateLimitStore()
    // An unknown IP must not put every anonymous caller in one shared bucket.
    for (let index = 0; index < 5; index += 1) {
      await checkRateLimit({
        store,
        sessionId: `${SESSION}${index}`,
        ip: null,
        perSession: '10/1h',
        perIp: '1/1h',
      })
    }
    expect(store.size).toBe(5)
  })

  it('evicts the least recently seen key rather than growing unbounded', async () => {
    const store = new MemoryRateLimitStore({ maxKeys: 2 })
    const rule = { limit: 10, windowMs: 60_000 }
    await store.hit('a', rule)
    await store.hit('b', rule)
    await store.hit('c', rule)
    expect(store.size).toBe(2)
  })
})

describe('request shape and size (docs/08 §7)', () => {
  it('rejects a content-length over the limit before parsing', () => {
    expect(
      codeOf(() => {
        checkContentLength('300000', 262_144)
      }),
    ).toBe('payload_too_large')
    expect(() => {
      checkContentLength(null, 262_144)
    }).not.toThrow()
  })

  it('accepts ULIDs and UUIDs as session ids and nothing else', () => {
    expect(isValidSessionId(SESSION)).toBe(true)
    expect(isValidSessionId('01J9X8Y7Z6ABCDEFGHJKMNPQRS')).toBe(true)
    expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isValidSessionId('../../etc/passwd')).toBe(false)
    expect(isValidSessionId('')).toBe(false)
  })

  it('rejects a malformed body with invalid_request', () => {
    expect(codeOf(() => parseChatRequest(null))).toBe('invalid_request')
    expect(codeOf(() => parseChatRequest({ messages: [] }))).toBe('invalid_request')
    expect(codeOf(() => parseChatRequest({ sessionId: SESSION }))).toBe('invalid_request')
    expect(
      codeOf(() => parseChatRequest({ sessionId: SESSION, messages: [{ role: 'user' }] })),
    ).toBe('invalid_request')
  })

  it('keeps only the fields it recognises', () => {
    const parsed = parseChatRequest({
      sessionId: SESSION,
      messages: [userMessage('hi')],
      trigger: 'submit-message',
      isAdmin: true,
    })
    expect(parsed).not.toHaveProperty('isAdmin')
    expect(parsed.trigger).toBe('submit-message')
  })

  it('finds the last user message, not the last message', () => {
    const messages = [
      userMessage('first', 'm_1'),
      { id: 'm_2', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'reply' }] },
    ]
    expect(lastUserMessage(messages)?.id).toBe('m_1')
    expect(lastUserMessage([])).toBeNull()
  })

  it('enforces maxUserMessageChars', () => {
    expect(
      codeOf(() => {
        checkMessageLength(userMessage('x'.repeat(20)), 8)
      }),
    ).toBe('invalid_request')
  })

  it('treats an uncompilable blockedPattern as matching nothing', () => {
    const compiled = compileBlockedPatterns(['ignore previous', '([unclosed'])
    expect(compiled).toHaveLength(1)
    expect(
      codeOf(() => {
        checkBlockedPatterns(userMessage('Ignore previous instructions'), compiled)
      }),
    ).toBe('invalid_request')
    expect(() => {
      checkBlockedPatterns(userMessage('where is my order?'), compiled)
    }).not.toThrow()
  })
})

describe('runGuards ordering (docs/04 §8)', () => {
  const input = (overrides: Partial<Parameters<typeof runGuards>[0]> = {}) => ({
    config: testConfig({
      security: { publicKey: 'pk_live_a1b2c3', allowedOrigins: ['https://acme.com'] },
    }),
    origin: 'https://acme.com',
    key: 'pk_live_a1b2c3',
    ip: '203.0.113.5',
    sessionId: SESSION,
    messages: [userMessage('hello')],
    token: null,
    selfOrigin: 'https://chat.acme.com',
    ...overrides,
  })

  const deps = () => ({ rateLimitStore: unlimitedRateLimitStore, logger: silentLogger })

  it('passes a well-formed request', async () => {
    await expect(runGuards(input(), deps())).resolves.toEqual({
      identity: null,
      allowOrigin: 'https://acme.com',
    })
  })

  it('rejects a bad origin before it looks at the key', async () => {
    const code = await asyncCodeOf(() =>
      runGuards(input({ origin: 'https://evil.com', key: 'wrong' }), deps()),
    )
    expect(code).toBe('origin_denied')
  })

  it('rejects a bad key before it spends a rate-limit slot', async () => {
    const store = new MemoryRateLimitStore()
    const code = await asyncCodeOf(() =>
      runGuards(input({ key: 'pk_live_wrong' }), { ...deps(), rateLimitStore: store }),
    )
    expect(code).toBe('invalid_key')
    expect(store.size).toBe(0)
  })

  /**
   * The acceptance criterion from docs/09 Phase 2: the rate limit must reject
   * before any model call is made. Guards run in @sitebot/server *before*
   * `handleChat`, so the strongest statement available here is that the limit
   * rejects before the expensive guard — auth, which may hit a JWKS endpoint —
   * has been consulted at all.
   */
  it('rejects on rate limit before verifying the token', async () => {
    const verify = vi.fn()
    const store = new MemoryRateLimitStore()
    const config = testConfig({
      security: {
        publicKey: 'pk_live_a1b2c3',
        allowedOrigins: ['https://acme.com'],
        rateLimit: { perSession: '1/1h' },
        auth: { mode: 'optional', jwt: { secret: 'shhh' } },
      },
    })
    const guardDeps = {
      rateLimitStore: store,
      logger: silentLogger,
      verifier: { verify: verify as never },
    }

    await runGuards(input({ config, token: 'a.b.c' }), guardDeps)
    expect(verify).toHaveBeenCalledTimes(1)

    const code = await asyncCodeOf(() => runGuards(input({ config, token: 'a.b.c' }), guardDeps))
    expect(code).toBe('rate_limited')
    // Still 1: the second request never reached the verifier.
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('rejects an over-long message last, after everything cheap has passed', async () => {
    const code = await asyncCodeOf(() =>
      runGuards(input({ messages: [userMessage('x'.repeat(9000))] }), deps()),
    )
    expect(code).toBe('invalid_request')
  })

  it('auth.mode: required with no token is 401', async () => {
    const config = testConfig({
      security: {
        publicKey: 'pk_live_a1b2c3',
        allowedOrigins: ['https://acme.com'],
        auth: { mode: 'required', jwt: { secret: 'shhh' } },
      },
    })
    expect(await asyncCodeOf(() => runGuards(input({ config }), deps()))).toBe('auth_required')
  })

  it('never derives an identity from an unverified token', async () => {
    const config = testConfig({
      security: {
        publicKey: 'pk_live_a1b2c3',
        allowedOrigins: ['https://acme.com'],
        auth: { mode: 'optional', jwt: { secret: 'shhh' } },
      },
    })
    // No verifier installed: the token is discarded, not decoded.
    const result = await runGuards(input({ config, token: 'a.b.c' }), deps())
    expect(result.identity).toBeNull()
  })
})
