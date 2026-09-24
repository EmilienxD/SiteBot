import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeAll, describe, expect, it } from 'vitest'
import { serveStatic } from './commands/static.js'

/** `--static <dir>` for `sitebot dev` / `sitebot serve`. */

let site: string
let widget: string

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'sitebot-static-'))
  site = join(root, 'public')
  await mkdir(join(site, 'docs'), { recursive: true })
  await writeFile(join(site, 'index.html'), '<h1>Home</h1>')
  await writeFile(join(site, 'pricing.html'), '<h1>Pricing</h1>')
  await writeFile(join(site, 'docs', 'index.html'), '<h1>Docs</h1>')
  await writeFile(join(site, 'style.css'), 'body{}')
  await writeFile(join(root, 'secret.env'), 'API_KEY=nope')
  await mkdir(join(root, 'widget'))
  widget = join(root, 'widget', 'sitebot.js')
  await writeFile(widget, 'export {}')
  await writeFile(join(root, 'widget', 'sitebot-panel.js'), 'export const panel = 1')
})

async function get(url: string, method = 'GET') {
  const reply = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  const response = {
    writeHead(status: number, headers: Record<string, unknown>) {
      reply.status = status
      reply.headers = headers
    },
    end(body?: Buffer) {
      reply.body = body?.toString() ?? ''
    },
  } as unknown as ServerResponse
  const handled = await serveStatic({ url, method } as IncomingMessage, response, {
    dir: site,
    widget,
    basePath: '/api/chat',
    cacheControl: 'no-store',
  })
  return { handled, ...reply }
}

describe('serveStatic', () => {
  it.each([
    ['/', '<h1>Home</h1>'],
    ['/pricing', '<h1>Pricing</h1>'],
    ['/pricing.html', '<h1>Pricing</h1>'],
    ['/docs/', '<h1>Docs</h1>'],
    ['/docs', '<h1>Docs</h1>'],
    ['/index.html?utm=x', '<h1>Home</h1>'],
  ])('serves %s', async (url, body) => {
    const reply = await get(url)
    expect(reply).toMatchObject({ handled: true, status: 200, body })
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8')
  })

  it('serves the widget entry and its lazy chunk from the installed package', async () => {
    expect(await get('/sitebot.js')).toMatchObject({ handled: true, body: 'export {}' })
    expect((await get('/sitebot-panel.js')).headers['content-type']).toContain('javascript')
  })

  it.each(['/../secret.env', '/%2e%2e/secret.env', '/docs/../../secret.env', '/..%5csecret.env'])(
    'refuses to escape the site root: %s',
    async (url) => {
      const reply = await get(url)
      expect(reply.handled).toBe(false)
      expect(reply.body).not.toContain('API_KEY')
    },
  )

  it('never shadows the endpoints', async () => {
    expect((await get('/api/chat')).handled).toBe(false)
    expect((await get('/api/chat/config')).handled).toBe(false)
  })

  it('leaves unknown paths and non-GET methods to the next handler', async () => {
    expect((await get('/missing')).handled).toBe(false)
    expect((await get('/', 'POST')).handled).toBe(false)
    expect(await get('/', 'HEAD')).toMatchObject({ handled: true, body: '' })
  })
})
