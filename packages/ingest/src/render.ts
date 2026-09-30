import {
  DEFAULT_UA,
  fetchPage,
  retryDelay,
  sleep,
  type Fetched,
  type HttpFetchOptions,
} from './http.js'
import type { Browser, BrowserContext } from 'playwright'

export const RENDER_SETUP =
  'Install JavaScript rendering with `pnpm add playwright` and `pnpm exec playwright install chromium` (npm: `npm install playwright && npx playwright install chromium`).'

/** Lazy optional dependency: ordinary HTML ingestion never starts a browser. */
export async function createRenderer(options: HttpFetchOptions): Promise<{
  fetch: (url: string) => Promise<Fetched>
  close: () => Promise<void>
}> {
  let browser: Browser
  try {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  } catch (cause) {
    throw new Error(
      `knowledge.extract.renderJs requires Playwright and Chromium. ${RENDER_SETUP}`,
      { cause },
    )
  }
  const contexts = new Set<BrowserContext>()
  return {
    async fetch(url) {
      // Shell validators cannot establish whether JavaScript/API content changed.
      const fetched = await fetchPage(url, options)
      if (fetched.status >= 400) return fetched
      const context = await browser.newContext({
        userAgent: options.userAgent ?? DEFAULT_UA,
        serviceWorkers: 'block',
      })
      contexts.add(context)
      try {
        let first = true
        let routeError: unknown
        await context.route('**/*', async (route) => {
          const request = route.request()
          try {
            if (options.allowed !== undefined && !(await options.allowed(request.url()))) {
              await route.abort('blockedbyclient')
              return
            }
            if (request.isNavigationRequest()) {
              const document = first ? fetched : await fetchPage(request.url(), options)
              first = false
              await route.fulfill({
                status: document.status,
                headers: {
                  ...document.headers,
                  'content-type': document.headers?.['content-type'] ?? 'text/html',
                },
                body: document.body,
              })
            } else {
              // Playwright does not route redirected requests again. Follow them
              // manually so neither scripts nor API calls bypass robots rules.
              let target = request.url()
              for (let redirects = 0; ; redirects++) {
                if (redirects > 10) throw new Error(`Too many redirects: ${request.url()}`)
                if (options.allowed !== undefined && !(await options.allowed(target))) {
                  await route.abort('blockedbyclient')
                  return
                }
                let response
                for (let attempt = 0; ; attempt++) {
                  const request = async () => {
                    await options.beforeRequest?.(target)
                    return route.fetch({ url: target, maxRedirects: 0, timeout: 30_000 })
                  }
                  response =
                    options.withRequest === undefined
                      ? await request()
                      : await options.withRequest(target, request)
                  if (
                    ![429, 503].includes(response.status()) ||
                    attempt >= (options.maxRetries ?? 2)
                  )
                    break
                  const delay = retryDelay(response.headers()['retry-after'] ?? null, attempt)
                  await response.dispose()
                  await (options.sleep ?? sleep)(delay)
                }
                if ([301, 302, 303, 307, 308].includes(response.status())) {
                  const location = response.headers()['location']
                  await response.dispose()
                  if (location === undefined)
                    throw new Error(`Redirect without Location: ${target}`)
                  target = new URL(location, target).href
                  if (!/^https?:/.test(target)) throw new Error(`Unsupported redirect: ${target}`)
                  continue
                }
                if (response.status() === 429 || response.status() >= 500) {
                  const status = response.status()
                  await response.dispose()
                  throw new Error(`HTTP fetch failed (${status}) at ${target}; ingestion stopped`)
                }
                try {
                  await route.fulfill({ response })
                } finally {
                  await response.dispose()
                }
                break
              }
            }
          } catch (error) {
            routeError = error
            await route.abort()
          }
        })
        const page = await context.newPage()
        await page.goto(fetched.url, { waitUntil: 'networkidle', timeout: 30_000 })
        if (routeError !== undefined) throw routeError
        return {
          status: fetched.status,
          url: page.url(),
          body: await page.content(),
          notModified: false,
        }
      } catch (cause) {
        throw new Error(`JavaScript rendering failed for ${url}; ingestion stopped`, { cause })
      } finally {
        contexts.delete(context)
        await context.close()
      }
    },
    async close() {
      await Promise.allSettled([...contexts].map((context) => context.close()))
      await browser.close()
    },
  }
}
