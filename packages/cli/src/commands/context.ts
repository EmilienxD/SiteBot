/**
 * What every command is handed, and the config-loading path they share.
 *
 * Commands are plain functions of a `CommandContext` returning an exit code,
 * with no `process.exit` anywhere below `cli.ts`. That is what lets the whole
 * command surface be tested by calling it: pass a `Ui` that writes to a string,
 * assert on the output and the code.
 */

import { access } from 'node:fs/promises'
import type { ResolvedConfig } from '@sitebot/config'
import { loadConfigWithWarnings } from '@sitebot/config/node'
import type { ConfigWarning } from '@sitebot/config'
import type { Ui } from '../terminal.js'

export interface CommandContext {
  ui: Ui
  cwd: string
  flags: Record<string, string | number | boolean>
  positionals: string[]
  env: NodeJS.ProcessEnv
  /** Scripted prompt answers, for tests. */
  answers?: string[]
  /** Injected in tests so no command reaches the network by accident. */
  fetchImpl?: typeof fetch
}

export interface CommandResult {
  exitCode: number
}

export interface LoadedConfig {
  config: ResolvedConfig
  warnings: ConfigWarning[]
}

/**
 * Load the config the way every command wants it.
 *
 * `dotenv: true` throughout: `.env` and `.env.local` are how a developer's key
 * reaches the CLI, and a `doctor` run that reported a missing key the app can
 * actually see would be worse than useless. Production injects real variables
 * and is unaffected — the files simply are not there.
 */
export async function loadForCommand(context: CommandContext): Promise<LoadedConfig> {
  const path = typeof context.flags['config'] === 'string' ? context.flags['config'] : undefined
  return await loadConfigWithWarnings(path, { cwd: context.cwd, dotenv: true })
}

/**
 * Print a thrown config error the way the config package formats it.
 *
 * `ConfigValidationError` and `ConfigLoadError` both carry a formatted message
 * and, for load errors, a `fix`. Re-formatting them here would let the CLI's
 * wording drift from the loader's, so this only unwraps.
 */
export function reportConfigError(ui: Ui, error: unknown): number {
  if (error instanceof Error) {
    const fix = (error as { fix?: unknown }).fix
    ui.fatal(error.message, typeof fix === 'string' ? fix : undefined)
    return 1
  }
  ui.fatal(String(error))
  return 1
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
