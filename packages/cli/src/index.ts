/**
 * @sitebot/cli — layer 4. Nothing imports this package.
 *
 * Implemented in Phase 9 — see docs/09-implementation-plan.md.
 */

export interface CommandSpec {
  readonly name: string
  readonly summary: string
}

/** The six commands, in the order `sitebot --help` prints them. docs/01 §2. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'init', summary: 'Scaffold config, route handler and script tag, interactively' },
  { name: 'validate', summary: 'Validate the config and print it resolved, with secrets masked' },
  { name: 'ingest', summary: 'Build or refresh the knowledge index' },
  { name: 'dev', summary: 'Local dev server and playground page, with config hot-reload' },
  { name: 'serve', summary: 'Production sidecar server (topology T2)' },
  { name: 'doctor', summary: 'Diagnose env vars, provider reachability, store health and CORS' },
]
