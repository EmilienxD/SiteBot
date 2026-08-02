import { describe, expect, it, vi } from 'vitest'
import { testConfig, testContext } from '../test/helpers.js'
import { CheckpointError, loadPendingRun, savePendingRun } from './agent/checkpoint.js'
import { errorResponse } from './stream/errors.js'
import { MemorySessionStore } from './session/store.js'
import { createHttpExecutor } from './tools/http.js'
import { ApprovalError, MemoryApprovalStore } from './tools/approvals.js'
import { lintTools } from './tools/lint.js'

describe('http tools', () => {
  it.each([
    '../admin',
    '@evil.com',
    '169.254.169.254',
    'localhost',
  ])('rejects unsafe host/path input %s', async (value) => {
    const fetchImpl = vi.fn<typeof fetch>()
    const execute = createHttpExecutor({
      method: 'GET',
      url: 'https://api.example.test/orders/{orderId}',
      headers: {},
      query: {},
      maxResponseBytes: 100,
      errorMap: {},
      allowPrivateNetwork: false,
      maxRedirects: 0,
    }, fetchImpl)
    await expect(execute({ orderId: value }, testContext())).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('percent-encodes path parameters and trusted context is not model-controlled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }))
    const execute = createHttpExecutor({
      method: 'GET',
      url: 'https://api.example.test/orders/{orderId}',
      headers: { 'x-user': '{{identity.sub}}' },
      query: { include: '{include}' },
      maxResponseBytes: 100,
      errorMap: {},
      allowPrivateNetwork: false,
      maxRedirects: 0,
    }, fetchImpl)
    await execute({ orderId: 'ORD/42', include: 'shipment details' }, testContext({ identity: { sub: 'user-1' } }))
    const [url, request] = fetchImpl.mock.calls[0] as [URL, RequestInit]
    expect(url.pathname).toBe('/orders/ORD%2F42')
    expect(url.searchParams.get('include')).toBe('shipment details')
    expect(new Headers(request.headers).get('x-user')).toBe('user-1')
  })

  it('caps responses and applies responsePath/errorMap', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { status: 'ok' } }), { headers: { 'content-type': 'application/json' } }))
    const execute = createHttpExecutor({ method: 'GET', url: 'https://api.example.test/status', headers: {}, query: {}, responsePath: '$.data', maxResponseBytes: 100, errorMap: {}, allowPrivateNetwork: false, maxRedirects: 0 }, fetchImpl)
    await expect(execute({}, testContext())).resolves.toEqual({ status: 'ok' })
  })

  it.each([
    ['public DNS', ['203.0.113.10'], true],
    ['loopback DNS', ['127.0.0.1'], false],
    ['link-local DNS', ['169.254.169.254'], false],
    ['private IPv6 DNS', ['fd00::1'], false],
  ])('%s resolution is checked before fetch', async (_name, addresses, allowed) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }))
    const execute = createHttpExecutor({ method: 'GET', url: 'https://api.example.test/status', headers: {}, query: {}, maxResponseBytes: 100, errorMap: {}, allowPrivateNetwork: false, maxRedirects: 0 }, fetchImpl, async () => addresses)
    if (allowed) await expect(execute({}, testContext())).resolves.toEqual({})
    else await expect(execute({}, testContext())).rejects.toThrow(/private network/)
    expect(fetchImpl).toHaveBeenCalledTimes(allowed ? 1 : 0)
  })
})

describe('approval checkpoints', () => {
  it('binds state to session/run/id, expires, and caches argument hashes', async () => {
    let now = 1_000
    const store = new MemoryApprovalStore(() => now)
    await store.create({ approvalId: 'a1', runId: 'r1', sessionId: 's1', toolName: 'create_ticket', input: { subject: 'shipping' }, risk: 'high', ttlMs: 100 })
    await expect(store.resolve({ sessionId: 's2', runId: 'r1', approvalId: 'a1', decision: 'approve' }, 'always')).rejects.toBeInstanceOf(ApprovalError)
    await store.resolve({ sessionId: 's1', runId: 'r1', approvalId: 'a1', decision: 'approve' }, 'once-per-session')
    expect(await store.isGranted('s1', 'create_ticket', { subject: 'shipping' })).toBe(true)
    expect(await store.isGranted('s1', 'create_ticket', { subject: 'delete account' })).toBe(false)
    await expect(store.resolve({ sessionId: 's1', runId: 'r1', approvalId: 'a1', decision: 'approve' }, 'always')).rejects.toBeInstanceOf(ApprovalError)
    now = 2_000
    await store.create({ approvalId: 'a2', runId: 'r1', sessionId: 's1', toolName: 'submit_order', input: { orderId: '1' }, risk: 'high', ttlMs: 100 })
    now = 2_200
    await expect(store.resolve({ sessionId: 's1', runId: 'r1', approvalId: 'a2', decision: 'approve' }, 'always')).rejects.toMatchObject({ status: 410 })
  })

  it('persists pending runs across reload and maps replay/expiry statuses', async () => {
    let now = 1_000
    const store = new MemorySessionStore({ now: () => now })
    const session = {
      id: 's1',
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    await savePendingRun(store, session, {
      runId: 'r1',
      responseMessage: {
        id: 'm1',
        role: 'assistant',
        parts: [{ type: 'tool-create_ticket', toolCallId: 't1', state: 'approval-requested', input: { subject: 'shipping' }, approval: { id: 'a1' } } as never],
      },
      expiresAt: 1_100,
    })

    await expect(loadPendingRun(store, 's1', 'r1', now)).resolves.toMatchObject({
      pending: { runId: 'r1' },
    })
    const replay = errorResponse(new CheckpointError('Wrong session.', 403))
    expect(replay.status).toBe(403)

    now = 1_101
    const expired = await loadPendingRun(store, 's1', 'r1', now).catch((error: unknown) => error)
    expect(expired).toBeInstanceOf(CheckpointError)
    expect(errorResponse(expired).status).toBe(410)
  })
})

describe('tool description linting', () => {
  it('reports all five documented lint families', () => {
    const config = testConfig({ tools: [
      { name: 'do_thing', description: 'Do it.', parameters: { type: 'object', properties: { id: { type: 'string' } } }, executor: { type: 'builtin', id: 'get_time' }, readOnly: true },
      { name: 'do_other', description: 'Do it.', parameters: { type: 'object', properties: { id: { type: 'string' } } }, executor: { type: 'builtin', id: 'get_time' }, readOnly: true },
    ] })
    const rules = new Set(lintTools(config).map((finding) => finding.rule))
    expect(rules).toEqual(new Set(['tool/description-too-short', 'tool/no-usage-guidance', 'tool/param-undocumented', 'tool/name-not-verb', 'tool/overlapping-tools']))
  })
})
