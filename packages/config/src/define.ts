import type { ExtendingConfig, SiteBotConfigInput } from './schema/config.js'

/**
 * Identity function that gives `chatbot.config.ts` full type inference and
 * autocomplete without a type annotation:
 *
 * ```ts
 * import { defineConfig } from '@sitebot/config'
 *
 * export default defineConfig({
 *   extends: './chatbot.config.yaml',
 *   tools: [{ name: 'quote', description: '…', execute: async (input, ctx) => … }],
 * })
 * ```
 *
 * The constraint says the thing docs/02-configuration.md §1 says in prose: a TS
 * config is either complete, or it declares what it `extends`. A file that is
 * missing `backend` *and* has nothing to inherit it from is a mistake worth
 * catching in the editor rather than at boot.
 *
 * It deliberately does not validate. Validation runs once, over the merged
 * result of the whole chain — a fragment that is incomplete on its own is the
 * normal case here, not an error.
 */
export function defineConfig<T extends SiteBotConfigInput | ExtendingConfig>(config: T): T {
  return config
}
