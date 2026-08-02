import type { UIMessage } from 'ai'
import { EngineError } from '../stream/errors.js'
import type { ChatRequest } from '../types.js'

// The guard pipeline and the history merge both need "the last user turn", and
// it has to be the *same* one — a guard that checked a different message from
// the one that reaches the model would be checking nothing.
export { lastUserMessage } from '../session/history.js'

/**
 * Shape and size guards — docs/08-security.md §7 "Request limits".
 *
 * Two limits at two layers, on purpose. `maxRequestBytes` is enforced by the
 * adapter *before* parsing, because a 40 MB body must never be buffered into a
 * string to discover it was too big. `maxUserMessageChars` is enforced here,
 * after parsing, because it is about one message rather than the envelope.
 */

/** ULID (Crockford base32) or a UUID. Anything else is not one of ours. */
const SESSION_ID_PATTERN = /^(?:s_)?(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-fA-F-]{36})$/

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/**
 * Reject an over-large body before it is read.
 *
 * `Content-Length` is a claim, not a fact — a chunked request has none, and a
 * lying one is possible. It is checked because it is free and stops the honest
 * majority early; the adapter still caps the actual read (see
 * `readBodyWithLimit` in @sitebot/server), which is the control that holds.
 */
export function checkContentLength(contentLength: string | null, maxRequestBytes: number): void {
  if (contentLength === null) return
  const bytes = Number(contentLength)
  if (!Number.isFinite(bytes)) return
  if (bytes > maxRequestBytes) {
    throw new EngineError('payload_too_large', {
      detail: `content-length ${bytes} exceeds security.maxRequestBytes ${maxRequestBytes}`,
    })
  }
}

/** All the text a user actually typed in one message. */
export function userMessageText(message: UIMessage): string {
  return (message.parts as { type: string; text?: unknown }[])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}

/**
 * Validate the parsed body. Deliberately structural only: this says the request
 * is *shaped* like a chat request, not that its contents are trustworthy.
 */
export function parseChatRequest(body: unknown): ChatRequest {
  if (typeof body !== 'object' || body === null) {
    throw new EngineError('invalid_request', { detail: 'body is not an object' })
  }
  const raw = body as Record<string, unknown>

  if (!isValidSessionId(raw.sessionId)) {
    throw new EngineError('invalid_request', { detail: 'sessionId is missing or malformed' })
  }
  if (!Array.isArray(raw.messages)) {
    throw new EngineError('invalid_request', { detail: 'messages must be an array' })
  }
  for (const message of raw.messages) {
    if (
      typeof message !== 'object' ||
      message === null ||
      typeof (message as { role?: unknown }).role !== 'string' ||
      !Array.isArray((message as { parts?: unknown }).parts)
    ) {
      throw new EngineError('invalid_request', { detail: 'a message is missing role or parts' })
    }
  }

  const request: ChatRequest = {
    sessionId: raw.sessionId,
    messages: raw.messages as UIMessage[],
  }
  if (raw.pageContext != null && typeof raw.pageContext === 'object') {
    request.pageContext = raw.pageContext as ChatRequest['pageContext']
  }
  if (typeof raw.auth === 'string') request.auth = raw.auth
  if (
    raw.trigger === 'submit-message' ||
    raw.trigger === 'regenerate' ||
    raw.trigger === 'resume'
  ) {
    request.trigger = raw.trigger
  }
  if (raw.resume !== undefined) {
    if (typeof raw.resume !== 'object' || raw.resume === null) throw new EngineError('invalid_request', { detail: 'resume must be an object' })
    const resume = raw.resume as Record<string, unknown>
    if (typeof resume.runId !== 'string' || resume.runId === '') throw new EngineError('invalid_request', { detail: 'resume.runId is required' })
    const parsed: ChatRequest['resume'] = { runId: resume.runId }
    if (Array.isArray(resume.approvals)) {
      parsed.approvals = resume.approvals.filter((item): item is { approvalId: string; decision: 'approve' | 'deny' } => typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).approvalId === 'string' && ((item as Record<string, unknown>).decision === 'approve' || (item as Record<string, unknown>).decision === 'deny'))
    }
    if (Array.isArray(resume.clientToolResults)) {
      parsed.clientToolResults = resume.clientToolResults.filter((item): item is { toolCallId: string; output: unknown } => typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).toolCallId === 'string' && 'output' in (item as Record<string, unknown>))
    }
    request.resume = parsed
  }

  return request
}

export function checkMessageLength(message: UIMessage, maxChars: number): void {
  const length = userMessageText(message).length
  if (length > maxChars) {
    throw new EngineError('invalid_request', {
      message: `That message is too long. Please keep it under ${maxChars} characters.`,
      detail: `user message is ${length} chars, limit ${maxChars}`,
    })
  }
}

/**
 * `security.blockedPatterns` — docs/08 §4.
 *
 * Documented as defence in depth against the lazy attempt, **not** a filter.
 * An invalid regex in config is treated as "matches nothing" plus a load-time
 * warning rather than a request-time crash: a typo in a security setting should
 * not take the endpoint down.
 */
export function compileBlockedPatterns(patterns: readonly string[]): RegExp[] {
  const compiled: RegExp[] = []
  for (const source of patterns) {
    try {
      compiled.push(new RegExp(source, 'i'))
    } catch {
      // Reported by `sitebot validate`; ignored here.
    }
  }
  return compiled
}

export function checkBlockedPatterns(message: UIMessage, patterns: readonly RegExp[]): void {
  if (patterns.length === 0) return
  const text = userMessageText(message)
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      throw new EngineError('invalid_request', {
        message: 'That message could not be processed.',
        detail: `matched security.blockedPatterns /${pattern.source}/`,
      })
    }
  }
}
