import { describe, expect, it } from 'vitest'
import { redact } from './logger.js'

describe('redact', () => {
  it('keeps an error cause chain and its codes, redacted like everything else', () => {
    const root = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), {
      code: 'ECONNREFUSED',
    })
    const error = new Error('The tool could not complete.', {
      cause: new TypeError('fetch failed', { cause: root }),
    })
    expect(redact(error)).toEqual({
      name: 'Error',
      message: 'The tool could not complete.',
      cause: {
        name: 'TypeError',
        message: 'fetch failed',
        cause: {
          name: 'Error',
          message: 'connect ECONNREFUSED 127.0.0.1:3000',
          code: 'ECONNREFUSED',
        },
      },
    })
  })

  it('includes an EngineError detail — the operator-only half of the message', () => {
    const error = Object.assign(new Error('That request could not be understood.'), {
      code: 'invalid_request',
      detail: 'sessionId: invalid ULID',
    })
    expect(redact(error)).toMatchObject({ detail: 'sessionId: invalid ULID' })
  })

  it('survives a cause cycle', () => {
    const error = new Error('a')
    error.cause = error
    expect(redact(error)).toEqual({ name: 'Error', message: 'a', cause: '[circular]' })
  })
})
