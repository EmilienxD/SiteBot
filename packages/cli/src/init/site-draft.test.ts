import { describe, expect, it, vi } from 'vitest'
import { draftSiteContext, extractDraft, SiteDraftError } from './site-draft.js'

/**
 * `sitebot init` fetches the homepage once and drafts `siteContext` from it —
 * the step that makes a first run site-aware (docs/06 §1). No real network:
 * `fetchImpl` is injected throughout.
 *
 * `routes` doubles as the allowlist for the builtin `navigate` tool (docs/02
 * §6), so the link-filtering rules below are a capability boundary, not a
 * tidiness preference. Anything that lands here is somewhere the assistant can
 * send a visitor.
 */

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Northwind Logistics &mdash; Freight for importers</title>
    <meta name="description" content="Ocean and air freight with customs brokerage included." />
    <meta property="og:site_name" content="Northwind" />
  </head>
  <body>
    <header>
      <a href="/">Home</a>
      <a href="/pricing">Pricing</a>
      <a href="/docs">API docs</a>
      <a href="/support/">Support</a>
    </header>
    <main><h1>Freight that clears customs</h1></main>
    <footer><a href="/legal/terms">Terms</a></footer>
  </body>
</html>`

/** A fetch that answers once with `body`, and records what it was asked. */
function stubFetch(body: string, init: { status?: number } = {}) {
  return vi.fn(async () => new Response(body, { status: init.status ?? 200 }))
}

const HOME = new URL('https://northwind.example.com/')

describe('draftSiteContext', () => {
  it('drafts company, description and routes from the homepage', async () => {
    const fetchImpl = stubFetch(PAGE)
    const draft = await draftSiteContext('https://northwind.example.com', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(draft.company).toBe('Northwind')
    expect(draft.description).toBe('Ocean and air freight with customs brokerage included.')
    expect(draft.primaryUrl).toBe('https://northwind.example.com')
    expect(draft.routes).toEqual([
      { path: '/pricing', summary: 'Pricing' },
      { path: '/docs', summary: 'API docs' },
      { path: '/support', summary: 'Support' },
    ])
  })

  it('adds a scheme to a bare hostname', async () => {
    const fetchImpl = stubFetch(PAGE)
    const draft = await draftSiteContext('northwind.example.com', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://northwind.example.com/')
    expect(draft.primaryUrl).toBe('https://northwind.example.com')
  })

  it('identifies itself and asks for HTML', async () => {
    const fetchImpl = stubFetch(PAGE)
    await draftSiteContext('https://northwind.example.com', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> }
    expect(init.headers['user-agent']).toBe('sitebot-init')
    expect(init.headers.accept).toContain('text/html')
    expect(init.redirect).toBe('follow')
  })

  it('rejects a URL that cannot be parsed, without fetching', async () => {
    const fetchImpl = stubFetch(PAGE)
    await expect(
      draftSiteContext('http://', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(SiteDraftError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a non-2xx response with a fix rather than a stack trace', async () => {
    const fetchImpl = stubFetch('nope', { status: 503 })
    const error = await draftSiteContext('https://northwind.example.com', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(SiteDraftError)
    expect((error as SiteDraftError).message).toContain('responded 503')
    expect((error as SiteDraftError).fix).toContain('by hand')
  })

  it('wraps a network failure, keeping the cause in the message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND northwind.example.com')
    })
    const error = await draftSiteContext('https://northwind.example.com', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(SiteDraftError)
    expect((error as SiteDraftError).message).toContain('ENOTFOUND')
  })

  it('gives up on a slow page instead of stalling init', async () => {
    // The abort is the point: `npx sitebot init` must not hang on a site that
    // accepts the connection and then says nothing.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }),
    )
    const error = await draftSiteContext('https://northwind.example.com', {
      timeoutMs: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(SiteDraftError)
    expect((error as SiteDraftError).message).toContain('timed out')
  })

  it('caps the bytes it parses', async () => {
    const padded = `${PAGE}${'<a href="/junk">junk</a>'.repeat(5000)}`
    const draft = await draftSiteContext('https://northwind.example.com', {
      maxBytes: PAGE.length,
      fetchImpl: stubFetch(padded) as unknown as typeof fetch,
    })
    expect(draft.routes.some((route) => route.path === '/junk')).toBe(false)
  })
})

describe('extractDraft — company and description', () => {
  it('prefers og:site_name over the title', () => {
    expect(extractDraft(PAGE, HOME).company).toBe('Northwind')
  })

  it('falls back to the title, trimmed at the brand separator', () => {
    const html = '<title>Northwind Logistics — Freight for importers</title>'
    expect(extractDraft(html, HOME).company).toBe('Northwind Logistics')
  })

  it('falls back to the hostname when the page says nothing', () => {
    expect(extractDraft('<html><body></body></html>', new URL('https://www.acme.com/')).company).toBe(
      'Acme',
    )
  })

  it('falls back through og:description to the h1', () => {
    const ogOnly = '<meta property="og:description" content="From the open graph tags." />'
    expect(extractDraft(ogOnly, HOME).description).toBe('From the open graph tags.')

    const h1Only = '<body><h1>  Freight that   clears customs  </h1></body>'
    expect(extractDraft(h1Only, HOME).description).toBe('Freight that clears customs')
  })

  it('decodes entities and collapses whitespace', () => {
    const html = '<meta name="description" content="Tom &amp; Jerry&#39;s\n  freight  desk" />'
    expect(extractDraft(html, HOME).description).toBe("Tom & Jerry's freight desk")
  })

  it('omits description entirely when there is none', () => {
    expect(extractDraft('<html></html>', HOME)).not.toHaveProperty('description')
  })

  it('reads content regardless of attribute order', () => {
    const html = '<meta content="Reversed attributes." name="description">'
    expect(extractDraft(html, HOME).description).toBe('Reversed attributes.')
  })
})

describe('extractDraft — routes (the navigate allowlist)', () => {
  const routesOf = (html: string, base = HOME) =>
    extractDraft(html, base).routes.map((route) => route.path)

  it('prefers nav and header links over every anchor on the page', () => {
    // A footer full of legal pages would pad the allowlist with noise.
    expect(routesOf(PAGE)).not.toContain('/legal/terms')
  })

  it('falls back to the whole document when there is no nav or header', () => {
    const html = '<body><a href="/pricing">Pricing</a><a href="/docs">Docs</a></body>'
    expect(routesOf(html)).toEqual(['/pricing', '/docs'])
  })

  it('drops cross-origin links', () => {
    const html = `<nav>
      <a href="https://twitter.com/northwind">Twitter</a>
      <a href="/pricing">Pricing</a>
    </nav>`
    expect(routesOf(html)).toEqual(['/pricing'])
  })

  it('drops fragments, mailto and javascript hrefs', () => {
    const html = `<nav>
      <a href="#main">Skip</a>
      <a href="mailto:hi@northwind.example.com">Email</a>
      <a href="javascript:void(0)">Menu</a>
      <a href="tel:+3312345678">Call</a>
      <a href="/pricing">Pricing</a>
    </nav>`
    expect(routesOf(html)).toEqual(['/pricing'])
  })

  it('drops asset links', () => {
    const html = `<nav>
      <a href="/logo.svg">Logo</a>
      <a href="/brochure.pdf">Brochure</a>
      <a href="/feed.xml">Feed</a>
      <a href="/docs">Docs</a>
    </nav>`
    expect(routesOf(html)).toEqual(['/docs'])
  })

  it('normalises trailing slashes and drops the root link', () => {
    const html = '<nav><a href="/">Home</a><a href="/pricing/">Pricing</a></nav>'
    expect(routesOf(html)).toEqual(['/pricing'])
  })

  it('resolves relative hrefs against the page URL', () => {
    const html = '<nav><a href="docs/api">API</a></nav>'
    expect(routesOf(html, new URL('https://northwind.example.com/guides/'))).toEqual([
      '/guides/docs/api',
    ])
  })

  it('keeps the first label for a duplicated path', () => {
    const html = '<nav><a href="/docs">API docs</a><a href="/docs">Read the docs</a></nav>'
    expect(extractDraft(html, HOME).routes).toEqual([{ path: '/docs', summary: 'API docs' }])
  })

  it('skips links with no label or an essay for a label', () => {
    const html = `<nav>
      <a href="/empty"><img src="/logo.png"></a>
      <a href="/verbose">${'long '.repeat(20)}</a>
      <a href="/pricing">Pricing</a>
    </nav>`
    expect(routesOf(html)).toEqual(['/pricing'])
  })

  it('strips markup out of a link label', () => {
    const html = '<nav><a href="/pricing"><span>Pricing</span> &amp; plans</a></nav>'
    expect(extractDraft(html, HOME).routes).toEqual([
      { path: '/pricing', summary: 'Pricing & plans' },
    ])
  })

  it('caps the draft at 12 routes', () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join('')
    expect(routesOf(`<nav>${links}</nav>`)).toHaveLength(12)
  })
})
