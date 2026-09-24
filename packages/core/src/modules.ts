import { EngineError } from './stream/errors.js'

/**
 * Load a developer's module by path — `module` tool executors (docs/05 §3),
 * `provider: custom` (docs/04 §2) and `storage.type: custom` (docs/02 §10).
 *
 * Kept free of `node:*` imports so the root entry stays edge-safe: on a
 * runtime without a filesystem the `import()` itself fails, and that failure
 * is reported as the configuration problem it is.
 */

/** `./providers/x.ts#factory` → `{ path: './providers/x.ts', exportName: 'factory' }`. */
export function parseModuleSpec(
  spec: string,
  defaultExport = 'default',
): { path: string; exportName: string } {
  const hash = spec.lastIndexOf('#')
  return hash > 0
    ? { path: spec.slice(0, hash), exportName: spec.slice(hash + 1) || defaultExport }
    : { path: spec, exportName: defaultExport }
}

/**
 * A `file:` URL for `path` relative to `baseDir`. Built by hand rather than
 * with `pathToFileURL` (which is `node:url`), and correct for Windows drive
 * paths, where the naive `file://C:\dir/` would parse `C` as a hostname.
 */
export function moduleUrl(path: string, baseDir: string | null | undefined): string {
  const windowsAbsolute = /^[a-z]:[\\/]/i
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !windowsAbsolute.test(path)) return path
  const toFileUrl = (absolute: string) => {
    const slashed = absolute.replace(/\\/g, '/')
    return `file://${slashed.startsWith('/') ? '' : '/'}${encodeURI(slashed)}`
  }
  if (windowsAbsolute.test(path) || path.startsWith('/')) return toFileUrl(path)
  const base = toFileUrl((baseDir ?? currentDir()).replace(/[\\/]?$/, '/'))
  return new URL(encodeURI(path.replace(/\\/g, '/')), base).href
}

function currentDir(): string {
  const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd
  if (typeof cwd !== 'function') {
    throw new EngineError('not_ready', {
      message: 'Loading a module by path needs a filesystem; this runtime has none.',
      detail: 'module path without a baseDir on a runtime without process.cwd()',
    })
  }
  return cwd()
}

export interface LoadExportOptions {
  baseDir?: string | null | undefined
  /** Append a cache-busting query so edits are picked up (dev hot reload). */
  fresh?: boolean
  /** What the export is, for the error message — "Module tool", "Custom provider". */
  kind: string
}

export async function loadModuleExport(
  path: string,
  exportName: string,
  options: LoadExportOptions,
): Promise<unknown> {
  const url = moduleUrl(path, options.baseDir)
  let module: Record<string, unknown>
  try {
    module = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ `${url}${options.fresh ? `?t=${Date.now()}` : ''}`
    )) as Record<string, unknown>
  } catch (error) {
    throw new EngineError('not_ready', {
      message: `${options.kind} module "${path}" could not be loaded.`,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
  if (!(exportName in module)) {
    throw new EngineError('not_ready', {
      message: `${options.kind} module "${path}" has no export named "${exportName}".`,
    })
  }
  return module[exportName]
}
