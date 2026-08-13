/**
 * Argument parsing.
 *
 * Hand-rolled rather than pulled from npm: the CLI is the one package a user
 * runs with `npx` before anything is installed, so every dependency here is
 * download time on a first run. The surface needed is small and fixed — six
 * commands, long flags, a handful of booleans — and a parser for it is fifty
 * lines. `node:util`'s `parseArgs` was the other candidate, but it throws on
 * unknown options rather than letting us print a did-you-mean, which is the
 * only interesting thing an argument parser does for a developer.
 */

export interface FlagSpec {
  /** `boolean` flags never consume the next token; `string` flags always do. */
  readonly type: 'boolean' | 'string' | 'number'
  readonly summary: string
  /** Single-letter alias, without the dash. */
  readonly short?: string
  /** Shown in `--help` as `--flag <placeholder>`. */
  readonly placeholder?: string
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>

export interface ParsedArgs {
  /** Everything that was not a flag or a flag value. */
  positionals: string[]
  flags: Record<string, string | number | boolean>
}

export class ArgError extends Error {
  readonly fix: string | undefined
  constructor(message: string, fix?: string) {
    super(message)
    this.name = 'ArgError'
    this.fix = fix
  }
}

/** Flags every command accepts, merged into each command's own set. */
export const GLOBAL_FLAGS: FlagSpecs = {
  config: {
    type: 'string',
    summary: 'Path to the config file. Defaults to the documented search order.',
    short: 'c',
    placeholder: '<path>',
  },
  cwd: { type: 'string', summary: 'Directory to run in. Defaults to the current one.' },
  help: { type: 'boolean', summary: 'Show help for this command.', short: 'h' },
  'no-color': { type: 'boolean', summary: 'Disable ANSI colour.' },
}

export function parseArgs(argv: readonly string[], specs: FlagSpecs): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | number | boolean> = {}
  const byShort = new Map<string, string>()
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.short !== undefined) byShort.set(spec.short, name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string

    // Everything after a bare `--` is positional, verbatim. `sitebot dev -- --port 1`
    // has to be able to pass a literal `--port` through to a wrapped process.
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }

    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }

    const isLong = token.startsWith('--')
    const body = token.slice(isLong ? 2 : 1)
    const equals = body.indexOf('=')
    const rawName = equals === -1 ? body : body.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : body.slice(equals + 1)
    const name = isLong ? rawName : (byShort.get(rawName) ?? rawName)

    const spec = specs[name]
    if (spec === undefined) {
      // `--no-foo` is accepted for any boolean `foo`, which is what a developer
      // reaches for when a config file has already turned something on.
      const negated = name.startsWith('no-') ? name.slice(3) : null
      if (negated !== null && specs[negated]?.type === 'boolean') {
        flags[negated] = false
        continue
      }
      throw new ArgError(`Unknown option "${token}".`, didYouMean(name, Object.keys(specs)))
    }

    if (spec.type === 'boolean') {
      if (inlineValue !== undefined) {
        if (inlineValue !== 'true' && inlineValue !== 'false') {
          throw new ArgError(`--${name} is a flag and takes no value.`)
        }
        flags[name] = inlineValue === 'true'
        continue
      }
      flags[name] = true
      continue
    }

    const value = inlineValue ?? argv[index + 1]
    if (value === undefined || (inlineValue === undefined && value.startsWith('-'))) {
      throw new ArgError(
        `--${name} needs a value.`,
        `Pass it as --${name} ${spec.placeholder ?? '<value>'}.`,
      )
    }
    if (inlineValue === undefined) index += 1

    if (spec.type === 'number') {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) {
        throw new ArgError(`--${name} must be a number, got "${value}".`)
      }
      flags[name] = parsed
      continue
    }
    flags[name] = value
  }

  return { positionals, flags }
}

/**
 * The closest candidate within an edit distance of a third of its length.
 *
 * The same rule the config loader uses for unknown keys, so a typo gets the
 * same quality of answer whether it is in the file or on the command line.
 */
export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | null = null
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate)
    if (best === null || distance < best.distance) best = { name: candidate, distance }
  }
  if (best === null) return undefined
  const threshold = Math.max(2, Math.floor(best.name.length / 3))
  return best.distance <= threshold ? `Did you mean --${best.name}?` : undefined
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        substitution,
      )
    }
    previous = current
  }
  return previous[b.length] as number
}

/** Render `--flag <value>  summary` lines for a command's help. */
export function formatFlags(specs: FlagSpecs): string[] {
  const rows = Object.entries(specs).map(([name, spec]) => {
    const short = spec.short === undefined ? '    ' : `-${spec.short}, `
    const value = spec.type === 'boolean' ? '' : ` ${spec.placeholder ?? '<value>'}`
    return [`${short}--${name}${value}`, spec.summary] as const
  })
  const width = Math.max(...rows.map(([left]) => left.length))
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`)
}
