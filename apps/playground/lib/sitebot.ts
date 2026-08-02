import { resolve } from 'node:path'
import { loadConfig } from '@sitebot/config/node'
import { createSiteBotHandler, type SiteBotHandler } from '@sitebot/server'

/**
 * One handler for the whole process.
 *
 * Next.js re-evaluates route modules on edits in dev, so the handler is cached
 * on `globalThis` rather than in a module-level variable. Without that, every
 * hot reload would build a fresh engine — and, more visibly, a fresh in-memory
 * session store and rate limiter, which makes both look broken while you are
 * developing against them.
 */

const CACHE_KEY = Symbol.for('sitebot.playground.handler')

type Cache = { [CACHE_KEY]?: Promise<SiteBotHandler> }

export function getHandler(): Promise<SiteBotHandler> {
  const cache = globalThis as Cache
  cache[CACHE_KEY] ??= build()
  return cache[CACHE_KEY]
}

async function build(): Promise<SiteBotHandler> {
  const config = await loadConfig(resolve(process.cwd(), 'chatbot.config.yaml'), {
    dotenv: true,
    onWarnings: (warnings) => {
      for (const warning of warnings) console.warn(`[sitebot] ${warning.path}: ${warning.message}`)
    },
  })

  return createSiteBotHandler(config, { version: '0.1.0-playground' })
}
