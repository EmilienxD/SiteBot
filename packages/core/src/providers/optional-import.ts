import { PROVIDER_PACKAGES, providerInstallSpec, type ProviderId } from '@sitebot/config'
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
export async function dynamicImport(specifier: string): Promise<Loaded> {
  return (await import(
    /* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ specifier
  )) as Loaded
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
    // Node says "Cannot find package"; Vite, esbuild and friends say "Could
    // not resolve" / "Failed to resolve".
    if (!/cannot find (module|package)|(failed to|could not) resolve/i.test(message)) return false
    return message.includes(specifier)
  }
  const message = (error as { message?: unknown }).message
  return typeof message !== 'string' || message.includes(specifier)
}

export function installHint(provider: ProviderId, specifier: string): EngineError {
  return new EngineError('not_ready', {
    message:
      `Provider "${provider}" requires an optional dependency.\n` +
      `  Install it:  pnpm add ${providerInstallSpec(specifier)}`,
    detail: `missing optional peer dependency ${specifier}`,
  })
}

/**
 * Import an optional peer the way the *project* would see it.
 *
 * A bare `import()` resolves from wherever this file is installed. That is
 * right for a flat `node_modules`, but under pnpm's isolated layout — and in
 * any workspace where `@sitebot/core` is linked rather than installed — the
 * project's own `@ai-sdk/anthropic` is invisible from here. So a miss falls
 * back to resolving from the project: the config file's directory, then the
 * working directory. `process.getBuiltinModule` reaches `node:module` without
 * a static Node import, so this file stays edge-safe; on the edge the fallback
 * simply does not exist and the original miss stands.
 */
export async function importOptional(
  specifier: string,
  options: { from?: Array<string | null | undefined> } = {},
): Promise<Loaded> {
  try {
    return await dynamicImport(specifier)
  } catch (error) {
    if (!isModuleNotFound(error, specifier)) throw error
    const fromProject = await importFromProject(specifier, options.from ?? [])
    if (fromProject !== undefined) return fromProject
    throw error
  }
}

type BuiltinGetter = (id: string) => unknown
interface NodeModuleApi {
  createRequire(path: string): { resolve(specifier: string): string }
}
interface NodeUrlApi {
  pathToFileURL(path: string): URL
}

async function importFromProject(
  specifier: string,
  from: Array<string | null | undefined>,
): Promise<Loaded | undefined> {
  const process = (
    globalThis as {
      process?: { getBuiltinModule?: BuiltinGetter; cwd?: () => string }
    }
  ).process
  const getBuiltin = process?.getBuiltinModule
  if (typeof getBuiltin !== 'function') return undefined
  const nodeModule = getBuiltin('node:module') as NodeModuleApi | undefined
  const nodeUrl = getBuiltin('node:url') as NodeUrlApi | undefined
  if (nodeModule === undefined || nodeUrl === undefined) return undefined
  const bases = [...from, process?.cwd?.()].filter(
    (base): base is string => typeof base === 'string' && base !== '',
  )
  for (const base of new Set(bases)) {
    let resolved: string
    try {
      resolved = nodeModule
        .createRequire(`${base.replace(/[\\/]+$/, '')}/noop.js`)
        .resolve(specifier)
    } catch {
      continue
    }
    const loaded = await dynamicImport(nodeUrl.pathToFileURL(resolved).href)
    // A CommonJS build imported from ESM puts its exports on `default` when
    // the lexer cannot see them; flatten so `createX` is found either way.
    const fallback = loaded.default
    return typeof fallback === 'object' && fallback !== null ? { ...fallback, ...loaded } : loaded
  }
  return undefined
}

/**
 * Import a provider SDK, translating a missing package into the install hint.
 */
export async function importProviderPackage(
  provider: ProviderId,
  options: { baseDir?: string | null | undefined } = {},
): Promise<Loaded> {
  const specifier = PROVIDER_PACKAGES[provider]
  if (specifier === null) {
    throw new EngineError('not_ready', {
      message: `Provider "${provider}" has no package to import.`,
    })
  }
  try {
    return await importOptional(specifier, { from: [options.baseDir] })
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
