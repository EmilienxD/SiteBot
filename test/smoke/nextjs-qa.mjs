/* global Element, document, window */
// Real relocated Next.js process, real provider SDK/SQLite/widget; synthetic
// loopback model HTTP only. Run by nextjs-standalone.mjs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { providerFixture, qaConfig, applicationTool } from './nextjs-provider.mjs'

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const session = () => `s_${randomUUID()}`

export async function verifyNextQa(app, deployment) {
  const provider = await providerFixture()
  let server
  const children = new Set()
  let log = ''
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((done) => socket.close(done))
  const origin = `http://127.0.0.1:${port}`
  const configFile = join(app, 'qa.config.json')
  const config = qaConfig(provider.baseUrl)
  let storeEnv = {}
  let requestOrigin
  const storeSecrets = []
  const save = (value = config) => writeFile(configFile, JSON.stringify(value))
  const secretFree = (text) => {
    assert(
      ![...Object.values(provider.keys), ...storeSecrets].some((key) => text.includes(key)),
      'Synthetic provider credential leaked into an HTTP response',
    )
  }
  async function launch(listenPort, inputFile = configFile) {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC'].includes(key.toUpperCase()),
      ),
    )
    const child = spawn(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${deployment}`,
        `--allow-fs-write=${join(app, 'runtime-state')}`,
        join(app, 'server.js'),
      ],
      {
        cwd: app,
        env: {
          ...environment,
          NODE_ENV: 'production',
          NEXT_TELEMETRY_DISABLED: '1',
          PORT: String(listenPort),
          HOSTNAME: '127.0.0.1',
          SITEBOT_CONFIG: inputFile,
          SITEBOT_TEST_CHAT_KEY: provider.keys.chat,
          ...storeEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    children.add(child)
    child.stdout.on('data', (data) => {
      log += data
    })
    child.stderr.on('data', (data) => {
      log += data
    })
    await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${listenPort}`)).ok
      } catch {
        return false
      }
    }, 'Production Next server did not start')
    return child
  }
  async function start() {
    server = await launch(port)
  }
  async function stop(child = server) {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit')
      child.kill()
      await closed
    }
    children.delete(child)
  }
  async function restart() {
    await stop()
    await start()
  }
  const post = (question, id = session(), locale = 'en', signal, target = origin) =>
    fetch(`${target}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(requestOrigin ? { origin: requestOrigin } : {}),
      },
      body: JSON.stringify({
        sessionId: id,
        locale,
        messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: question }] }],
      }),
      ...(signal ? { signal } : {}),
    })
  async function answer(question, id, locale, target = origin) {
    const response = await post(question, id, locale, undefined, target)
    assert.equal(response.status, 200, `Q&A returned ${response.status}`)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    assert.match(response.headers.get('cache-control'), /no-transform/)
    assert.equal(response.headers.get('x-accel-buffering'), 'no')
    assert.equal(response.headers.get('content-encoding'), null, 'Next compressed the SSE response')
    const events = []
    let pending = ''
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      for (;;) {
        const end = pending.indexOf('\n\n')
        if (end < 0) break
        const line = pending.slice(0, end)
        pending = pending.slice(end + 2)
        if (line.startsWith('data: ') && line !== 'data: [DONE]')
          events.push({ ...JSON.parse(line.slice(6)), receivedAt: Date.now() })
      }
    }
    secretFree(JSON.stringify(events))
    assert(
      !events.some((event) =>
        /^(error|data-error|data-navigate|data-client-tool-call|data-approval-request)$/.test(
          event.type,
        ),
      ),
      'Unexpected error/action part',
    )
    const text = events.filter((e) => e.type === 'text-delta')
    assert(text.length >= 2, 'Expected multiple text deltas')
    assert(text.at(-1).receivedAt - text[0].receivedAt >= 60, 'Production SSE was buffered')
    const citations = events.filter((e) => e.type === 'data-citations').flatMap((e) => e.data.items)
    assert(citations.length > 0, 'Verified source metadata missing')
    return { events, citations, text: text.map((e) => e.delta).join('') }
  }
  try {
    await writeFile(join(app, 'application-tool.mjs'), applicationTool)
    await mkdir(join(app, 'runtime-state'), { recursive: true })
    await save({ ...config, version: 999 })
    await start()
    // A transient config error must not poison the lazy handler forever.
    const invalid = await fetch(`${origin}/api/chat/config`)
    assert.equal(invalid.status, 500)
    secretFree(await invalid.text())
    await save()
    const recovered = await fetch(`${origin}/api/chat/config`)
    assert.equal(recovered.status, 200, 'Lazy Next handler did not recover after config repair')
    const publicConfig = await recovered.text()
    secretFree(publicConfig)
    assert(!/backend|apiKey|runtime-inputs/.test(publicConfig))
    assert.match(recovered.headers.get('cache-control'), /^public,/)
    const french = await fetch(`${origin}/api/chat/config`, {
      headers: { 'accept-language': 'fr' },
    })
    assert.equal(await french.text(), publicConfig, 'Shared config varied by request language')
    const probe = await fetch(`${origin}/api/chat/config?sessionId=${session()}`)
    assert.equal(probe.headers.get('cache-control'), 'private, no-store')
    process.stdout.write(
      'Production lazy config recovery and public/private locale caching passed.\n',
    )

    const health = await fetch(`${origin}/api/chat/health`)
    const report = await health.json()
    assert.equal(health.status, 200, 'Packaged provider SDK or store could not initialize')
    assert.equal(report.checks.provider.status, 'ok')
    const id = session()
    const en = await answer('Pro plan trial', id, 'en')
    assert.match(en.text, /12.*\[1\]/)
    assert.equal(en.citations[0].url, 'https://docs.example.com/en/plans')
    assert(en.events.some((e) => e.type === 'tool-output-available'))
    await restart()
    const followup = await answer('followup trial', id, 'fr')
    assert.match(followup.text, /7 jours \[1\]/)
    assert.equal(
      followup.citations[0].chunkId,
      en.citations[0].chunkId,
      'Disk-backed citation provenance changed after restart',
    )
    const fr = await answer('forfait Pro essai', id, 'fr')
    assert.match(fr.text, /\[2\]/)
    assert.equal(
      fr.citations.find((source) => source.id === 'c1').url,
      'https://docs.example.com/en/plans',
    )
    assert.equal(
      fr.citations.find((source) => source.id === 'c2').url,
      'https://docs.example.com/fr/plans',
    )
    const separate = await answer('forfait Pro essai', session(), 'fr')
    assert.equal(separate.citations[0].lang, 'fr')
    assert.equal(separate.citations[0].id, 'c1')
    const loopStart = provider.calls.length
    const loop = await answer('loop Pro plan trial', session(), 'en')
    const loopCalls = provider.calls.slice(loopStart).filter((call) => call.kind === 'chat')
    assert.equal(
      loopCalls.length,
      4,
      'Production model loop exceeded or ignored its four-step limit',
    )
    assert(loopCalls.slice(0, 3).every((call) => call.body.tools?.length === 1))
    assert.equal((loopCalls.at(-1).body.tools ?? []).length, 0, 'Final answer still exposed search')
    assert.equal(loop.events.filter((event) => event.type === 'tool-output-available').length, 3)
    process.stdout.write(
      'Production application tool → answer SSE, bilingual sources and SQLite restart continuity passed.\n',
    )

    await browserChecks(origin, app, secretFree, provider)

    const cancelledBefore = provider.cancelled
    await new Promise((done, reject) => {
      const request = httpRequest(
        `${origin}/api/chat`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, agent: false },
        (response) => {
          response.on('data', (part) => {
            if (!part.toString().includes('text-delta')) return
            response.destroy()
            request.destroy()
            done()
          })
        },
      )
      request.on('error', (error) => {
        if (error.code !== 'ECONNRESET') reject(error)
      })
      request.end(
        JSON.stringify({
          sessionId: session(),
          locale: 'en',
          messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'slow' }] }],
        }),
      )
    })
    await until(
      () => provider.cancelled > cancelledBefore,
      `Socket disconnect did not cancel the synthetic provider stream: ${JSON.stringify(provider.streams.filter((stream) => stream.slow))}`,
    )
    provider.failure = true
    const failed = await post('Pro plan trial')
    assert.equal(failed.status, 502)
    secretFree(await failed.text())
    provider.failure = false
    await answer('Pro plan trial')
    process.stdout.write('Production disconnect cancellation and provider-error recovery passed.\n')

    await save({
      ...config,
      security: { ...config.security, rateLimit: { perSession: '1/1m', perIp: '100/1m' } },
    })
    await restart()
    const limited = session()
    await answer('Pro plan trial', limited)
    const blocked = await post('Pro plan trial', limited, 'fr')
    assert.equal(blocked.status, 429)
    assert.match(
      blocked.headers.get('cache-control') ?? '',
      /no-store|no-cache/,
      'Session/locale-specific rate error can be cached',
    )
    assert(Number(blocked.headers.get('retry-after')) > 0)
    const error = await blocked.text()
    secretFree(error)
    assert.match(error, /rate_limited/)
    await restart()
    await answer('Pro plan trial', limited)
    await save({
      ...config,
      security: { ...config.security, budget: { maxTokensPerSession: 1, onExceeded: 'error' } },
    })
    await restart()
    const before = provider.calls.length
    const budget = await post('Pro plan trial', session(), 'fr')
    assert.equal(budget.status, 402)
    assert.match(
      budget.headers.get('cache-control') ?? '',
      /no-store|no-cache/,
      'Session/locale-specific budget error can be cached',
    )
    secretFree(await budget.text())
    assert.equal(provider.calls.length, before, 'Budget rejection reached the provider')
    await save({
      ...config,
      security: { ...config.security, budget: { maxTokensPerSession: 1, onExceeded: 'message' } },
    })
    await restart()
    const budgetMessage = await post('Pro plan trial', session(), 'fr')
    assert.equal(budgetMessage.status, 200)
    const budgetWire = await budgetMessage.text()
    secretFree(budgetWire)
    assert.match(
      budgetMessage.headers.get('cache-control') ?? '',
      /no-transform/,
      'Budget message SSE bypassed the anti-buffering response headers',
    )
    assert.equal(budgetMessage.headers.get('x-accel-buffering'), 'no')
    assert.equal(provider.calls.length, before, 'Budget message reached the provider')
    const blockedPath = join(app, 'runtime-state/blocked')
    await writeFile(blockedPath, 'Synthetic path obstruction')
    await save({
      ...config,
      storage: { type: 'sqlite', path: './runtime-state/blocked/sessions.db' },
    })
    await restart()
    assert.equal((await fetch(`${origin}/api/chat/health`)).status, 503)
    const storeFailure = await post('Pro plan trial')
    assert.equal(storeFailure.status, 500)
    secretFree(await storeFailure.text())
    await unlink(blockedPath)
    assert.equal((await fetch(`${origin}/api/chat/health`)).status, 200)
    await answer('Pro plan trial')
    process.stdout.write(
      'Production rate limiting and pre-provider budget rejection passed (local counters only).\n',
    )
    if (process.env.SITEBOT_LIVE_NEXT_STORES === '1') await sharedStores()
    assert.deepEqual(provider.errors, [])
    process.stdout.write(
      `Synthetic HTTP requests: ${provider.calls.filter((c) => c.kind === 'chat').length} model, paid inference: 0.\n`,
    )
  } catch (error) {
    // Server diagnostics may contain the intentionally synthetic canaries.
    for (const key of [...Object.values(provider.keys), ...storeSecrets])
      log = log.replaceAll(key, '[server-secret]')
    process.stderr.write(log.slice(-6000))
    throw error
  } finally {
    for (const child of children) await stop(child)
    await provider.close()
  }

  async function sharedStores() {
    // Explicit opt-in: dedicated disposable Redis DB and Postgres database.
    // The normal artifact gate never requires or connects to these services.
    const redisUrl = process.env.SITEBOT_LIVE_REDIS_URL
    const pgUrl = process.env.SITEBOT_LIVE_PG_URL
    assert(redisUrl && pgUrl, 'Shared-store gate requires both live store URLs')
    for (const url of [redisUrl, pgUrl]) {
      assert(
        ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname),
        'Disposable shared-store gate accepts loopback services only',
      )
      storeSecrets.push(...[url, decodeURIComponent(new URL(url).password)].filter(Boolean))
    }
    const require = createRequire(new URL('../../packages/core/package.json', import.meta.url))
    const { createClient } = require('redis')
    const pg = require('pg')
    const redis = createClient({ url: redisUrl, socket: { reconnectStrategy: false } })
    redis.on('error', () => {})
    const admin = new pg.Pool({ connectionString: pgUrl })
    let peer
    let ownsSessions = false
    const freshSession = session
    try {
      await redis.connect()
      assert.equal(
        await redis.dbSize(),
        0,
        'Shared-store gate requires an empty disposable Redis database',
      )
      assert.equal(
        (await admin.query("SELECT to_regclass('sitebot_sessions') AS name")).rows[0].name,
        null,
        'Shared-store gate requires a disposable Postgres database without sitebot_sessions',
      )
      ownsSessions = true
      // Both backend ports serve one visitor-facing origin. The session's
      // security fingerprint must describe that same visitor on each replica.
      requestOrigin = 'https://docs.example.com'
      const reserve = createServer().listen(0, '127.0.0.1')
      await once(reserve, 'listening')
      const peerPort = reserve.address().port
      await new Promise((done) => reserve.close(done))
      const peerOrigin = `http://127.0.0.1:${peerPort}`
      const dayKey = `sitebot:budget:day:${new Date().toISOString().slice(0, 10)}`
      const usage = async (key) => {
        const [tokens, usd] = await redis.hmGet(key, ['tokens', 'usd'])
        return { tokens: Number(tokens ?? 0), usd: Number(usd ?? 0) }
      }
      const deny = async (target, question, expected = 402, id = freshSession()) => {
        const before = provider.calls.length
        const response = await post(question, id, 'fr', undefined, target)
        assert.equal(response.status, expected)
        secretFree(await response.text())
        assert.equal(provider.calls.length, before, 'Shared rejection reached an model provider')
      }
      for (const type of ['redis', 'postgres']) {
        await stop(peer)
        peer = undefined
        await stop()
        storeEnv = {
          SITEBOT_TEST_STORE_URL: type === 'redis' ? redisUrl : pgUrl,
          SITEBOT_TEST_REDIS_URL: redisUrl,
          SITEBOT_TEST_PG_URL: pgUrl,
        }
        const shared = {
          ...config,
          backend: {
            ...config.backend,
            pricing: {
              'openai:synthetic-runtime': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
            },
          },
          storage: { type, url: '${env.SITEBOT_TEST_STORE_URL}', ttlSeconds: 60 },
          security: {
            allowedOrigins: [requestOrigin],
            rateLimit: {
              store: 'redis',
              url: '${env.SITEBOT_TEST_REDIS_URL}',
              perSession: '100/1m',
              perIp: '1000/1m',
            },
            budget: {
              maxTokensPerSession: 1000000,
              maxTokensPerDay: 1000000,
              maxUsdPerDay: 1,
              onExceeded: 'error',
            },
          },
        }
        await save(shared)
        await start()
        peer = await launch(peerPort)
        const publicPayload = await (await fetch(`${peerOrigin}/api/chat/config`)).text()
        secretFree(publicPayload)
        const id = freshSession()
        const before = await usage(dayKey)
        const en = await answer('Pro plan trial', id, 'en')
        const fr = await answer('followup trial', id, 'fr', peerOrigin)
        assert.deepEqual(fr.citations, en.citations)
        await restart()
        const newSource = await answer('forfait Pro essai', id, 'fr')
        assert.equal(
          newSource.citations.find((c) => c.id === 'c1').url,
          'https://docs.example.com/en/plans',
        )
        assert.equal(
          newSource.citations.find((c) => c.id === 'c2').url,
          'https://docs.example.com/fr/plans',
        )
        await stop(peer)
        peer = await launch(peerPort)
        const retained = await answer('followup trial', id, 'en', peerOrigin)
        assert.match(retained.text, /7 days/)
        assert.equal(retained.citations.find((c) => c.id === 'c1').chunkId, en.citations[0].chunkId)
        const after = await usage(dayKey)
        assert.equal(
          after.tokens - before.tokens,
          240,
          'Completed multi-step usage was lost across processes/restarts',
        )
        assert(
          Math.abs(after.usd - before.usd - 0.0003) < 1e-10,
          'Fixture-priced USD accounting drifted',
        )
        assert.equal((await usage(`sitebot:budget:session:${id}`)).tokens, 240)

        // Wrong Redis value types must fail closed, then recover in the same
        // handlers when repaired, without touching an inference provider.
        const savedUsage = await redis.hGetAll(dayKey)
        await redis.del(dayKey)
        await redis.set(dayKey, 'synthetic wrong type')
        await deny(origin, 'Pro plan trial', 500)
        await redis.del(dayKey)
        await redis.hSet(dayKey, savedUsage)
        const sessionKey = `sitebot:session:${id}`
        const savedSession =
          type === 'redis'
            ? await redis.get(sessionKey)
            : (await admin.query('SELECT data FROM sitebot_sessions WHERE id = $1', [id])).rows[0]
                .data
        if (type === 'redis')
          await redis.set(sessionKey, '{synthetic malformed JSON', { PX: 60000 })
        else
          await admin.query('UPDATE sitebot_sessions SET data = $2 WHERE id = $1', [
            id,
            JSON.stringify({ ...savedSession, messages: null }),
          ])
        await deny(peerOrigin, 'followup trial', 500, id)
        if (type === 'redis') await redis.set(sessionKey, savedSession, { PX: 60000 })
        else
          await admin.query('UPDATE sitebot_sessions SET data = $2 WHERE id = $1', [
            id,
            JSON.stringify(savedSession),
          ])
        const repaired = await answer('followup trial', id, 'fr', peerOrigin)
        assert.deepEqual(repaired.citations, retained.citations)

        await redis.hSet(dayKey, { tokens: '1000001', usd: '0' })
        await deny(peerOrigin, 'Pro plan trial')
        await restart()
        await deny(origin, 'Pro plan trial')
        await redis.hSet(dayKey, { tokens: '0', usd: '2' })
        await deny(peerOrigin, 'Pro plan trial')
        await redis.del(dayKey)
        const exhaustedSession = freshSession()
        await redis.hSet(`sitebot:budget:session:${exhaustedSession}`, {
          tokens: '1000001',
          usd: '0',
        })
        await deny(origin, 'Pro plan trial', 402, exhaustedSession)
        await deny(peerOrigin, 'Pro plan trial', 402, exhaustedSession)

        await save({
          ...shared,
          security: {
            ...shared.security,
            rateLimit: { ...shared.security.rateLimit, perSession: '1/1m' },
          },
        })
        await restart()
        await stop(peer)
        peer = await launch(peerPort)
        const burstId = freshSession()
        const callsBefore = provider.calls.length
        const burst = await Promise.all(
          Array.from({ length: 10 }, async (_, i) => {
            const response = await post(
              'Pro plan trial',
              burstId,
              'en',
              undefined,
              i % 2 ? origin : peerOrigin,
            )
            secretFree(await response.text())
            return response.status
          }),
        )
        assert.equal(burst.filter((status) => status === 200).length, 1)
        assert.equal(burst.filter((status) => status === 429).length, 9)
        assert.equal(
          provider.calls.length - callsBefore,
          3,
          'Rejected burst requests accessed the model',
        )
        await restart()
        await deny(origin, 'Pro plan trial', 429, burstId)

        // Deliberately demonstrate check-before/record-after admission. These
        // artificial output prices make overlapping completed calls overshoot.
        await redis.del(dayKey)
        const overshoot = {
          ...shared,
          backend: {
            ...shared.backend,
            pricing: {
              'openai:synthetic-runtime': { inputUsdPerMillion: 0, outputUsdPerMillion: 1000000 },
            },
          },
          security: { ...shared.security, budget: { maxUsdPerDay: 15, onExceeded: 'error' } },
        }
        await save(overshoot)
        await restart()
        await stop(peer)
        peer = await launch(peerPort)
        await Promise.all([
          answer('Pro plan trial', freshSession(), 'en'),
          answer('forfait Pro essai', freshSession(), 'fr', peerOrigin),
        ])
        assert.deepEqual(await usage(dayKey), { tokens: 160, usd: 40 })
        await deny(origin, 'Pro plan trial')
        await redis.del(dayKey)
        process.stdout.write(
          `Production shared ${type} sessions/citations + Redis counters: two Next processes, both restarted; burst and pre-provider rejection passed. Fixture $15 threshold admitted $40 overlapping output: no strict spend reservation.\n`,
        )
      }
    } finally {
      await stop(peer)
      await stop()
      if (redis.isOpen) {
        // Only the dedicated empty-on-entry DB is accepted above. Delete just
        // the exact SiteBot keys this fixture owns; never FLUSHDB/FLUSHALL.
        if (ownsSessions)
          for await (const keys of redis.scanIterator({ MATCH: 'sitebot:*', COUNT: 100 }))
            if (keys.length) await redis.del(keys)
        await redis.quit()
      }
      if (ownsSessions) await admin.query('DROP TABLE IF EXISTS sitebot_sessions')
      await admin.end()
      storeEnv = {}
      requestOrigin = undefined
    }
  }
}

async function until(check, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(100)
  }
  assert.fail(message)
}

async function browserChecks(origin, app, secretFree, provider) {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ locale: 'en-US' })
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    )
    const page = await context.newPage()
    await page.addInitScript(() => {
      const attach = Element.prototype.attachShadow
      Element.prototype.attachShadow = function (init) {
        return attach.call(this, { ...init, mode: 'open' })
      }
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(origin)
    secretFree(await page.content())
    await page.evaluate(() => {
      document.documentElement.lang = 'fr'
    })
    const host = page.locator('site-chat')
    await host.getByRole('button', { name: 'Ouvrir l’assistant de discussion' }).click()
    const panel = host.locator('.panel')
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).waitFor()
    assert.equal(await panel.locator('textarea').getAttribute('placeholder'), 'Votre question…')
    const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/chat'))
    const received = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/chat'),
    )
    await panel.locator('textarea').fill('forfait Pro essai')
    await panel.locator('textarea').press('Enter')
    const request = await sent
    assert.equal(request.postDataJSON().locale, 'fr')
    assert.equal(request.headers()['accept-language'], 'fr')
    const reply = await received
    // Chromium does not retain no-store SSE bodies for getResponseBody.
    // Wire/canary checks run through the HTTP reader above; here assert the
    // browser's actual consumed UI instead of requesting a cached stream.
    assert.equal(reply.status(), 200, 'Browser chat failed')
    await panel.locator('.citation-chip').waitFor()
    assert.match(await panel.locator('.message.assistant .bubble').last().textContent(), /12/)
    secretFree(await panel.getByRole('log').textContent())
    await host.evaluate((element) => {
      element.addEventListener('sitebot:citation-click', (event) => {
        window.__runtimeCitation = event.detail
      })
    })
    await panel.locator('.citation-chip').first().click()
    assert.equal(
      await page.evaluate(() => window.__runtimeCitation?.url),
      'https://docs.example.com/fr/plans',
    )
    await page.evaluate(() => {
      document.documentElement.lang = 'en'
    })
    await panel.getByRole('button', { name: 'Send message', exact: true }).waitFor()
    assert.match(await panel.getByRole('log').textContent(), /forfait Pro essai/)
    await host.evaluate((element) => element.setLocale('fr-CA'))
    await panel.getByRole('button', { name: 'Envoyer', exact: true }).waitFor()
    await page.reload()
    await page.waitForFunction(() => window.SiteBot)
    await page.evaluate(() => window.SiteBot.open())
    await host.locator('.citation-chip').waitFor()
    assert.equal(await host.locator('.citation-n').last().textContent(), '1')
    const cancelledBefore = provider.cancelled
    await host.evaluate((element) => element.setLocale('en'))
    await host.locator('textarea').fill('slow')
    await host.locator('textarea').press('Enter')
    await host.getByRole('button', { name: 'Stop response', exact: true }).waitFor()
    await until(
      async () =>
        (await host.locator('.message.assistant .bubble').last().textContent()).includes(
          'Synthetic runtime',
        ),
      'First browser slow-response text',
    )
    await host.getByRole('button', { name: 'Stop response', exact: true }).click()
    await until(
      () => provider.cancelled > cancelledBefore,
      'Widget Stop did not cancel upstream inference',
    )
    await host.getByRole('button', { name: 'Send message', exact: true }).waitFor()
    assert.deepEqual(errors, [])
    // Fetch every built browser asset, including lazy chunks not in page HTML.
    const assets = await readdir(join(app, '.next/static'), { recursive: true })
    let exposedMaps = 0
    for (const asset of assets.filter((p) => /\.(js|css|map)$/.test(p))) {
      const url = `${origin}/_next/static/${asset.replaceAll('\\', '/')}`
      const response = await fetch(url)
      assert.equal(response.status, 200, `Missing browser asset ${asset}`)
      const text = await response.text()
      secretFree(text)
      if (asset.endsWith('.map')) exposedMaps++
      if (asset.endsWith('.js')) {
        const map = await fetch(`${url}.map`)
        if (map.ok) {
          exposedMaps++
          secretFree(await map.text())
        }
      }
    }
    for (const path of [
      '/qa.config.json',
      '/chatbot.config.yaml',
      '/runtime-state/sessions.db',
      '/.env',
      '/.next/server/app/api/chat/route.js.map',
    ]) {
      const response = await fetch(origin + path)
      assert.equal(response.status, 404, `Server-only input exposed: ${path}`)
      secretFree(await response.text())
    }
    process.stdout.write(
      `Production widget hydration/lazy chunks, EN/FR controls, persisted citation chips and browser canary separation passed (${exposedMaps} exposed source maps inspected).\n`,
    )
  } finally {
    await browser.close()
  }
}
