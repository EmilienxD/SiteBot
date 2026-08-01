import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { parse as parseToml } from 'smol-toml'
import { ConfigLoadError } from '../errors.js'
import { PACKAGE_JSON_KEY } from '../index.js'

/** Extensions that need a JavaScript runtime rather than a text parser. */
const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

export function isCodeConfig(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path))
}

/**
 * Read and parse one config file into a plain object.
 *
 * Does not merge `extends`, interpolate, or validate — those operate on the
 * whole chain, and keeping this function to "bytes in, object out" is what
 * makes the loader's control flow readable.
 */
export async function parseConfigFile(path: string): Promise<unknown> {
  const extension = extname(path)

  if (basename(path) === 'package.json') {
    const pkg = await readJson(path)
    const section = (pkg as Record<string, unknown>)[PACKAGE_JSON_KEY]
    if (section === undefined) {
      throw new ConfigLoadError(`${path} has no "${PACKAGE_JSON_KEY}" key.`, {
        fix: `Add a "${PACKAGE_JSON_KEY}" object, or create a chatbot.config.yaml.`,
      })
    }
    return section
  }

  if (isCodeConfig(path)) return importCodeConfig(path)

  const source = await readText(path)

  switch (extension) {
    case '.yaml':
    case '.yml':
      return parseWith(() => parseYaml(source), path, 'YAML')
    case '.json':
      return parseWith(() => JSON.parse(source) as unknown, path, 'JSON')
    case '.toml':
      return parseWith(() => parseToml(source), path, 'TOML')
    default:
      throw new ConfigLoadError(`Unsupported config file extension "${extension}" (${path}).`, {
        fix: 'Use .ts, .mts, .js, .mjs, .yaml, .yml, .json or .toml.',
      })
  }
}

function parseWith(parse: () => unknown, path: string, format: string): unknown {
  try {
    return parse()
  } catch (cause) {
    throw new ConfigLoadError(`${path} is not valid ${format}: ${(cause as Error).message}`, {
      cause,
      fix: `Fix the ${format} syntax and try again.`,
    })
  }
}

/**
/** Paths already imported in this process, so re-imports can bust the cache. */
const imported = new Set<string>()

/**
 * Import a `.ts` / `.js` config and unwrap its default export.
 *
 * The ESM module cache is keyed by URL, so `sitebot dev` cannot see an edited
 * config without a distinguishing query string. It is added only on re-import:
 * a query on a first load is pointless, and some toolchains stop recognising
 * the `.ts` extension once one is present.
 */
async function importCodeConfig(path: string): Promise<unknown> {
  const url = pathToFileURL(path)
  if (imported.has(path)) {
    url.searchParams.set('sitebot_mtime', String(await mtime(path)))
  }
  imported.add(path)

  let module: Record<string, unknown>
  try {
    module = (await import(url.href)) as Record<string, unknown>
  } catch (cause) {
    throw asImportError(path, cause)
  }

  const value = module['default'] ?? module['config'] ?? module
  if (typeof value !== 'object' || value === null) {
    throw new ConfigLoadError(`${path} does not export a configuration object.`, {
      fix: 'Export the config as the default export: `export default defineConfig({ … })`.',
    })
  }
  return value
}

/**
 * TypeScript config files rely on the running Node stripping types (22.18+ and
 * 23.6+ do so by default). Older runtimes fail with a syntax error that says
 * nothing about the cause, so translate it into the two things that fix it.
 */
function asImportError(path: string, cause: unknown): ConfigLoadError {
  const message = cause instanceof Error ? cause.message : String(cause)
  const looksLikeTypeStripping =
    /\.[mc]?ts$/.test(path) &&
    /Unknown file extension|Unexpected token|Invalid or unexpected token|ERR_UNKNOWN_FILE_EXTENSION/i.test(
      message,
    )

  if (looksLikeTypeStripping) {
    return new ConfigLoadError(
      `Could not import ${path}: this Node build cannot run TypeScript directly.`,
      {
        cause,
        fix: `Upgrade to Node 22.18+ or 24, run with --experimental-strip-types, or rename the file to chatbot.config.mjs. Node ${process.versions.node} is in use.`,
      },
    )
  }

  return new ConfigLoadError(`Could not import ${path}: ${message}`, { cause })
}

async function mtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (cause) {
    throw new ConfigLoadError(`Could not read ${path}.`, {
      cause,
      fix: 'Check the path and that the file is readable.',
    })
  }
}

async function readJson(path: string): Promise<unknown> {
  const source = await readText(path)
  return parseWith(() => JSON.parse(source) as unknown, path, 'JSON')
}
