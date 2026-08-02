import { PROVIDER_PACKAGES, type ProviderId } from '@sitebot/config'
import { EngineError } from '../stream/errors.js'

/**
 * Provider SDKs are optional peer dependencies (docs/04 §2 property 2), so a
 * project's lockfile contains only what it uses. That means two things this
 * module has to arrange:
 *
 *  1. The specifier must not be a literal, or TypeScript would demand the
 *     package be installed to typecheck this repo, and a bundler would try to
 *     resolve every provider at build time.
 *  2. A missing package must produce the install command, not a stack trace.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loaded = Record<string, any>

/** `import()` behind a variable, so nothing resolves it statically. */
async function dynamicImport(specifier: string): Promise<Loaded> {
  return (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as Loaded
}

/**
 * Node, Deno and every bundler word this differently, so match on the code
 * where there is one and fall back to the message shape. Getting this wrong in
 * the permissive direction would turn a genuine bug inside a provider SDK into
 * a misleading "run pnpm add" message, hence the specificity check on the name.
 */
export function isModuleNotFound(error: unknown, specifier: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    const message = (error as { message?: unknown }).message
    if (typeof message !== 'string') return false
    if (!/cannot find (module|package)|failed to resolve/i.test(message)) return false
    return message.includes(specifier)
  }
  const message = (error as { message?: unknown }).message
  return typeof message !== 'string' || message.includes(specifier)
}

export function installHint(provider: ProviderId, specifier: string): EngineError {
  return new EngineError('not_ready', {
    message:
      `Provider "${provider}" requires an optional dependency.\n` +
      `  Install it:  pnpm add ${specifier}`,
    detail: `missing optional peer dependency ${specifier}`,
  })
}

/**
 * Import a provider SDK, translating a missing package into the install hint.
 */
export async function importProviderPackage(provider: ProviderId): Promise<Loaded> {
  const specifier = PROVIDER_PACKAGES[provider]
  if (specifier === null) {
    throw new EngineError('not_ready', {
      message: `Provider "${provider}" has no package to import.`,
    })
  }
  try {
    return await dynamicImport(specifier)
  } catch (error) {
    if (isModuleNotFound(error, specifier)) throw installHint(provider, specifier)
    throw error
  }
}

/** Read an environment variable without assuming Node — core runs on the edge. */
export function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  return env?.[name]
}
