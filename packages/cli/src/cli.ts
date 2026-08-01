#!/usr/bin/env node
import { COMMANDS } from './index.js'

/**
 * The `sitebot` binary. Argument parsing and the commands themselves land in
 * Phase 9; for now this prints usage so the built bin is at least honest about
 * what it does not do yet.
 */
function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
  return ['Usage: sitebot <command> [options]', '', 'Commands:', ...lines, ''].join('\n')
}

const [command] = process.argv.slice(2)

if (!command || command === '--help' || command === '-h') {
  console.log(usage())
  process.exit(0)
}

if (COMMANDS.some((c) => c.name === command)) {
  console.error(`sitebot ${command}: not implemented yet (Phase 9).`)
  process.exit(1)
}

console.error(`Unknown command "${command}".\n\n${usage()}`)
process.exit(1)
