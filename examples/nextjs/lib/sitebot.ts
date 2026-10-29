import 'server-only'
// Declare the selected lazy SDK to Next's tracer. Keep this server-side and
// update it with serverExternalPackages when selecting a different provider.
import '@ai-sdk/openai'
import { loadConfig } from '@sitebot/config/node'
import { createRouteHandlers, type NextRouteHandlers } from '@sitebot/server/next'

/**
 * The route handlers, built on the first request rather than at import.
 *
 * `next build` imports every route module to read its exports, and loading the
 * config there would demand an API key just to build. Cached on `globalThis`
 * so `next dev`'s hot reloads reuse one engine instead of building a new one
 * per edit.
 *
 * `SITEBOT_CONFIG` points at another config file — CI uses it to swap in an
 * offline model; you will not normally set it.
 */
const KEY = Symbol.for('sitebot.example.nextjs')

type Cache = { [KEY]?: Promise<NextRouteHandlers> }

export function handlers(): Promise<NextRouteHandlers> {
  const cache = globalThis as Cache
  cache[KEY] ??= loadConfig(process.env.SITEBOT_CONFIG, { dotenv: true })
    .then((config) => createRouteHandlers(config))
    .catch((error: unknown) => {
      // Share an in-flight attempt, but let a repaired runtime input recover.
      delete cache[KEY]
      throw error
    })
  return cache[KEY]
}
