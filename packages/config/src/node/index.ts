/**
 * `@sitebot/config/node` — the filesystem half of the config package.
 *
 * Split out so the root entry stays importable from a browser bundle
 * (docs/01-architecture.md §2), mirroring the `@sitebot/core` / `@sitebot/core/node`
 * boundary. Everything that touches `node:fs` lives here and nowhere else.
 */

import { access, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { ConfigLoadError, ConfigValidationError } from '../errors.js'
import { mergeConfigChain } from '../merge.js'
import { validateConfig } from '../validate.js'
import { CONFIG_FILENAMES } from '../index.js'
import { parseConfigFile } from './parse.js'
import { loadEnvFiles } from './dotenv.js'
import type { ResolvedConfig, ValidateOptions } from '../validate.js'
import type { ConfigWarning } from '../types.js'

export { parseConfigFile, isCodeConfig } from './parse.js'
export { loadEnvFiles, parseDotenv } from './dotenv.js'

export interface LoadConfigOptions extends ValidateOptions {
  /** Directory the search starts in. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Layer `.env` and `.env.local` under the process environment before
   * resolving `${env.*}`. The CLI turns this on for `dev` and `serve`;
   * production is expected to inject real variables (docs/02 §2).
   */
  dotenv?: boolean
  /** Collected non-fatal findings, if the caller wants them. */
  onWarnings?: (warnings: ConfigWarning[]) => void
}

/** Everything `loadConfig` produced, for callers that want the warnings too. */
export interface LoadConfigResult {
  config: ResolvedConfig
  warnings: ConfigWarning[]
}

/**
 * Find, read, merge, resolve and validate a config.
 *
 * Accepts a path, an already-built object (the `defineConfig` result, say), or
 * nothing at all — in which case the search order of docs/02-configuration.md §1
 * applies.
 *
 * Throws `ConfigValidationError` when the config is invalid; the message is a
 * formatted report and `.errors` carries the structured version.
 */
export async function loadConfig(
  pathOrObject?: string | Record<string, unknown>,
  options: LoadConfigOptions = {},
): Promise<ResolvedConfig> {
  const { config, warnings } = await loadConfigWithWarnings(pathOrObject, options)
  options.onWarnings?.(warnings)
  return config
}

export async function loadConfigWithWarnings(
  pathOrObject?: string | Record<string, unknown>,
  options: LoadConfigOptions = {},
): Promise<LoadConfigResult> {
  const cwd = options.cwd ?? process.cwd()

  const { raw, sourcePath, baseDir, extendsChain } =
    typeof pathOrObject === 'object' && pathOrObject !== null
      ? { raw: pathOrObject as unknown, sourcePath: null, baseDir: cwd, extendsChain: [] }
      : await readChain(await resolveEntry(pathOrObject, cwd))

  const env = options.env ?? baseEnvironment(cwd, options.dotenv ?? false)
  const withPrompt = await inlineSystemFile(raw, baseDir)

  const result = validateConfig(withPrompt, {
    ...options,
    env,
    sourcePath,
    baseDir,
    extendsChain,
  })

  if (!result.ok) {
    throw new ConfigValidationError(result.errors, { sourcePath })
  }
  return { config: result.value, warnings: result.warnings }
}

/** The first config file that exists, per docs/02-configuration.md §1. */
export async function findConfigFile(cwd: string): Promise<string | null> {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = resolve(cwd, filename)
    if (await exists(candidate)) return candidate
  }

  const packageJson = resolve(cwd, 'package.json')
  if (await exists(packageJson)) {
    const source = await readFile(packageJson, 'utf8').catch(() => null)
    if (source !== null && /"sitebot"\s*:/.test(source)) return packageJson
  }

  return null
}

async function resolveEntry(path: string | undefined, cwd: string): Promise<string> {
  if (path !== undefined) {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path)
    if (!(await exists(absolute))) {
      throw new ConfigLoadError(`No config file at ${absolute}.`, {
        fix: 'Check the --config path.',
      })
    }
    return absolute
  }

  const found = await findConfigFile(cwd)
  if (found === null) {
    throw new ConfigLoadError(`No SiteBot config found in ${cwd}.`, {
      fix: `Create one of ${CONFIG_FILENAMES.join(', ')}, add a "sitebot" key to package.json, or pass --config <path>. \`npx sitebot init\` scaffolds one.`,
    })
  }
  return found
}

interface RawChain {
  raw: unknown
  sourcePath: string
  baseDir: string
  extendsChain: string[]
}

/**
 * Read `entry` and everything it `extends`, and fold them together.
 *
 * `extends` is applied left to right with the extending file on top, and a
 * file's own `extends` is resolved relative to that file — so a shared preset
 * two directories away can extend its own neighbours without knowing who
 * imported it.
 */
async function readChain(entry: string): Promise<RawChain> {
  const visited = new Set<string>()
  const chain: string[] = []

  const read = async (path: string, stack: string[]): Promise<unknown> => {
    if (stack.includes(path)) {
      throw new ConfigLoadError(`Circular \`extends\`: ${[...stack, path].join(' → ')}.`, {
        fix: 'Break the cycle — a config may not extend itself, directly or otherwise.',
      })
    }
    if (!(await exists(path))) {
      throw new ConfigLoadError(`Extended config not found: ${path}.`, {
        fix: 'Paths in `extends` are resolved relative to the file that declares them.',
      })
    }

    const parsed = await parseConfigFile(path)
    if (path !== entry && !visited.has(path)) {
      visited.add(path)
      chain.push(path)
    }

    const parents = extendsOf(parsed, path)
    if (parents.length === 0) return parsed

    const here = dirname(path)
    const bases: unknown[] = []
    for (const parent of parents) {
      bases.push(await read(resolve(here, parent), [...stack, path]))
    }
    return mergeConfigChain([...bases, parsed])
  }

  const raw = await read(entry, [])
  return { raw, sourcePath: entry, baseDir: dirname(entry), extendsChain: chain }
}

function extendsOf(parsed: unknown, path: string): string[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const value = (parsed as Record<string, unknown>)['extends']
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value
  }
  throw new ConfigLoadError(`\`extends\` in ${path} must be a string or an array of strings.`, {
    fix: 'For example: extends: ./chatbot.config.yaml',
  })
}

/**
 * Read `prompt.systemFile` into `prompt.system`.
 *
 * The two are mutually exclusive in the schema, so `systemFile` is dropped
 * once it has been read. The path is resolved against the entry config's
 * directory, matching "relative to the config file" in docs/02 §5.
 */
async function inlineSystemFile(raw: unknown, baseDir: string): Promise<unknown> {
  if (typeof raw !== 'object' || raw === null) return raw
  const config = raw as Record<string, unknown>
  const prompt = config['prompt']
  if (typeof prompt !== 'object' || prompt === null) return raw

  const promptRecord = prompt as Record<string, unknown>
  const systemFile = promptRecord['systemFile']
  if (typeof systemFile !== 'string') return raw

  const path = isAbsolute(systemFile) ? systemFile : resolve(baseDir, systemFile)

  let system: string
  try {
    system = await readFile(path, 'utf8')
  } catch (cause) {
    throw new ConfigLoadError(`Could not read prompt.systemFile: ${path}.`, {
      cause,
      fix: 'The path is resolved relative to the config file.',
    })
  }

  const { systemFile: _removed, ...rest } = promptRecord
  return { ...config, prompt: { ...rest, system } }
}

function baseEnvironment(cwd: string, useDotenv: boolean): Record<string, string | undefined> {
  return useDotenv ? loadEnvFiles(cwd, process.env) : { ...process.env }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
