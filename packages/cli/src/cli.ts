#!/usr/bin/env node
/**
 * The `sitebot` binary.
 *
 * A thin dispatcher: parse the command, parse its flags, build a `Ui` and a
 * `CommandContext`, call the command, exit with its code. Everything a command
 * does is below `commands/` and returns an exit code rather than calling
 * `process.exit` — that is what keeps the whole surface callable from tests
 * (docs/09 §Phase 9).
 */

import { COMMANDS } from './index.js'
import { ArgError, formatFlags, GLOBAL_FLAGS, parseArgs, type FlagSpecs } from './args.js'
import { shouldColor, Ui } from './terminal.js'
import type { CommandContext, CommandResult } from './commands/context.js'
import { runInit, INIT_FLAGS } from './commands/init.js'
import { runValidate, VALIDATE_FLAGS } from './commands/validate.js'
import { runDev, DEV_FLAGS } from './commands/dev.js'
import { runServe, SERVE_FLAGS } from './commands/serve.js'
import { runDoctor, DOCTOR_FLAGS } from './commands/doctor.js'

type CommandFn = (context: CommandContext) => Promise<CommandResult>

interface CommandEntry {
  summary: string
  run: CommandFn
  flags: FlagSpecs
}

const REGISTRY: Record<string, CommandEntry> = {
  init: { summary: summaryOf('init'), run: runInit, flags: INIT_FLAGS },
  validate: { summary: summaryOf('validate'), run: runValidate, flags: VALIDATE_FLAGS },
  dev: { summary: summaryOf('dev'), run: runDev, flags: DEV_FLAGS },
  serve: { summary: summaryOf('serve'), run: runServe, flags: SERVE_FLAGS },
  doctor: { summary: summaryOf('doctor'), run: runDoctor, flags: DOCTOR_FLAGS },
}

function summaryOf(name: string): string {
  return COMMANDS.find((command) => command.name === name)?.summary ?? ''
}

function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
  return [
    'Usage: sitebot <command> [options]',
    '',
    'Commands:',
    ...lines,
    '',
    '  -h, --help  Show help for a command, e.g. sitebot dev --help',
    '',
  ].join('\n')
}

function commandUsage(name: string, entry: CommandEntry): string {
  const specs = { ...entry.flags, ...GLOBAL_FLAGS }
  return [
    `Usage: sitebot ${name} [options]`,
    '',
    entry.summary,
    '',
    'Options:',
    ...formatFlags(specs),
    '',
  ].join('\n')
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv

  if (name === undefined || name === '--help' || name === '-h') {
    process.stdout.write(usage())
    return 0
  }

  const entry = REGISTRY[name]
  if (entry === undefined) {
    process.stderr.write(`Unknown command "${name}".\n\n${usage()}`)
    return 1
  }

  const specs: FlagSpecs = { ...entry.flags, ...GLOBAL_FLAGS }

  let parsed
  try {
    parsed = parseArgs(rest, specs)
  } catch (error) {
    if (error instanceof ArgError) {
      const ui = new Ui()
      ui.fatal(error.message, error.fix)
      return 1
    }
    throw error
  }

  const ui = new Ui({
    color: parsed.flags['no-color'] === true ? false : shouldColor(),
  })

  if (parsed.flags['help'] === true) {
    ui.line(commandUsage(name, entry))
    return 0
  }

  const context: CommandContext = {
    ui,
    cwd: typeof parsed.flags['cwd'] === 'string' ? parsed.flags['cwd'] : process.cwd(),
    flags: parsed.flags,
    positionals: parsed.positionals,
    env: process.env,
  }

  const result = await entry.run(context)
  return result.exitCode
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exit(1)
  },
)
