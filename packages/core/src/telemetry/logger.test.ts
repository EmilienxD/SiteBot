import { describe, expect, it } from 'vitest'
import { redact } from './logger.js'
import { APICallError } from '@ai-sdk/provider'
import { ToolChoiceViolationError } from 'ai'

describe('redact', () => {
  it('preserves actionable provider status without logging request or response content', () => {
    const error = new APICallError({
      message: 'PRIVATE_PROVIDER_MESSAGE',
      url: 'https://example.test/PRIVATE_URL',
      requestBodyValues: { prompt: 'PRIVATE_PROMPT' },
      responseBody: 'PRIVATE_RESPONSE',
      responseHeaders: { authorization: 'PRIVATE_CREDENTIAL' },
      statusCode: 400,
      isRetryable: false,
    })
    expect(redact(error)).toEqual({
      name: 'AI_APICallError',
      message: '[redacted]',
      statusCode: 400,
      isRetryable: false,
    })
  })

  it('retains the enforced choice and finish category of a rejected tool response', () => {
    const error = new ToolChoiceViolationError({
      toolChoice: { type: 'none' },
      finishReason: 'tool-calls',
      provider: 'google.vertex',
      modelId: 'gemini-3.5-flash-lite',
      content: [
        { type: 'tool-call', toolCallId: 'private', toolName: 'private', input: 'PRIVATE_INPUT' },
      ],
    })
    expect(redact(error)).toEqual({
      name: 'AI_ToolChoiceViolationError',
      message: '[redacted]',
      finishReason: 'tool-calls',
      toolChoice: { type: 'none' },
    })
  })

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
