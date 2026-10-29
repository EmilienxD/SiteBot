import { describe, expect, it } from 'vitest'
import { CheckpointError } from '../agent/checkpoint.js'
import { EngineError, errorResponse, ERROR_TABLE, mapError } from './errors.js'

/**
 * docs/04 §7: `mapError` is normative. Every internal error maps to
 * `{ code, message, retryable }` from a fixed table; provider text, stack
 * traces, paths and keys never reach the browser.
 */
describe('mapError', () => {
  const providerText = 'Incorrect API key provided: sk-live-abc123 at /srv/app/node_modules/x.js:10'

  it('maps an unknown error to the fixed internal_error entry, dropping its text', () => {
    const mapped = mapError(new Error(providerText))
    expect(mapped).toEqual({
      code: 'internal_error',
      message: ERROR_TABLE.internal_error.message,
      retryable: true,
    })
    expect(JSON.stringify(mapped)).not.toContain('sk-live')
  })

  it('does not trust a third-party error just because its status is 403 or 410', () => {
    // An SDK error carrying `status: 403` is not one of our checkpoint errors.
    const sdkError = Object.assign(new Error(providerText), { status: 403 })
    expect(mapError(sdkError).message).toBe(ERROR_TABLE.internal_error.message)
    expect(JSON.stringify(mapError(sdkError))).not.toContain('sk-live')
  })

  it('passes our own checkpoint errors through, with their status', async () => {
    const error = new CheckpointError('This request has expired.', 410)
    expect(mapError(error)).toMatchObject({
      code: 'invalid_request',
      message: 'This request has expired.',
    })
    expect(errorResponse(error).status).toBe(410)
  })

  it('uses the EngineError message, which is ours by construction', () => {
    expect(mapError(new EngineError('provider_error'))).toEqual({
      code: 'provider_error',
      message: ERROR_TABLE.provider_error.message,
      retryable: true,
    })
  })

  it('maps an abort to aborted, not an error the user should retry', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(mapError(abort)).toMatchObject({ code: 'aborted', retryable: false })
  })

  it('adds detail only in debug and never in production', () => {
    const error = new Error(providerText)
    expect(mapError(error, { debug: true }).detail).toBe(providerText)
    expect(mapError(error, { debug: true, production: true }).detail).toBeUndefined()
    expect(mapError(error).detail).toBeUndefined()
  })
})

describe('EngineError', () => {
  it.each(['rate_limited', 'budget_exceeded', 'provider_error'] as const)(
    'does not cache session/locale-dependent %s responses',
    (code) => {
      for (const locale of ['en', 'fr']) {
        const response = errorResponse(new EngineError(code, { headers: { 'retry-after': '3' } }), {
          locale,
          production: true,
        })
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(response.headers.get('retry-after')).toBe('3')
      }
    },
  )
  it('degrades an unknown code to internal_error instead of throwing', () => {
    const error = new EngineError('no_such_code' as never)
    expect(error.code).toBe('internal_error')
    expect(error.status).toBe(500)
  })
})
