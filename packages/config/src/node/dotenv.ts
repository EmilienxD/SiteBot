import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A deliberately small `.env` reader.
 *
 * docs/02-configuration.md §2 says `.env` and `.env.local` are auto-loaded in
 * `dev` and `serve`, and production injects real variables. That is a narrow
 * enough job to do in thirty lines: `KEY=value`, optional `export` prefix,
 * quoted values with escapes inside double quotes, `#` comments. Anything more
 * exotic belongs in the developer's own tooling, not in a layer-1 package that
 * is supposed to have no dependencies.
 *
 * Nothing here mutates `process.env` — the parsed values are handed to the
 * interpolator instead, so loading a config can never leak variables into the
 * rest of the process.
 */

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/

export function parseDotenv(source: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const match = LINE.exec(line)
    if (!match) continue
    const [, key, rawValue = ''] = match
    if (key === undefined) continue

    out[key] = unquote(rawValue)
  }

  return out
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') {
      return value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    }
    if (first === "'" && last === "'") return value.slice(1, -1)
  }
  // Unquoted values stop at an inline comment.
  const comment = value.indexOf(' #')
  return (comment === -1 ? value : value.slice(0, comment)).trim()
}

/**
 * Read `.env` then `.env.local` from `cwd`, layered under `base`.
 *
 * Precedence, lowest first: `.env`, `.env.local`, then whatever the process
 * already has. A real environment variable always wins over a file, which is
 * what makes the same config work in CI without deleting the developer's
 * `.env`.
 */
export function loadEnvFiles(
  cwd: string,
  base: Readonly<Record<string, string | undefined>> = {},
  files: readonly string[] = ['.env', '.env.local'],
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {}

  for (const file of files) {
    const contents = tryRead(resolve(cwd, file))
    if (contents === null) continue
    Object.assign(merged, parseDotenv(contents))
  }

  return { ...merged, ...base }
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
