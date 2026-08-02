/**
 * Terminal output.
 *
 * One module owns colour and symbols so that `--no-color`, a redirected stdout
 * and a CI log all produce the same text with the escape codes removed, rather
 * than each command deciding for itself. Everything writes through `Ui` so
 * tests can capture output without touching `process.stdout`.
 */

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  cyan: '[36m',
} as const

export type Style = keyof Omit<typeof ANSI, 'reset'>

export interface UiOptions {
  color?: boolean
  write?: (text: string) => void
  writeError?: (text: string) => void
}

/**
 * Colour is on when stdout is a TTY, `--no-color` was not passed, and neither
 * `NO_COLOR` nor a non-interactive `CI` says otherwise. `FORCE_COLOR` wins over
 * all of it, because that is what a developer sets when piping into `less -R`.
 */
export function shouldColor(env: NodeJS.ProcessEnv = process.env, isTty = process.stdout.isTTY) {
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return true
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false
  if (env['TERM'] === 'dumb') return false
  return isTty === true
}

export class Ui {
  private readonly color: boolean
  private readonly out: (text: string) => void
  private readonly err: (text: string) => void

  constructor(options: UiOptions = {}) {
    this.color = options.color ?? shouldColor()
    this.out = options.write ?? ((text) => process.stdout.write(text))
    this.err = options.writeError ?? ((text) => process.stderr.write(text))
  }

  style(text: string, ...styles: Style[]): string {
    if (!this.color || styles.length === 0) return text
    return `${styles.map((name) => ANSI[name]).join('')}${text}${ANSI.reset}`
  }

  line(text = ''): void {
    this.out(`${text}\n`)
  }

  errorLine(text = ''): void {
    this.err(`${text}\n`)
  }

  heading(text: string): void {
    this.line()
    this.line(this.style(text, 'bold'))
  }

  /** A key/value row, indented, used by `validate` and `doctor`. */
  detail(label: string, value: string): void {
    this.line(`  ${this.style(label, 'dim')} ${value}`)
  }

  success(text: string): void {
    this.line(`${this.style('✓', 'green')} ${text}`)
  }

  warn(text: string): void {
    this.line(`${this.style('!', 'yellow')} ${text}`)
  }

  fail(text: string): void {
    this.line(`${this.style('✗', 'red')} ${text}`)
  }

  info(text: string): void {
    this.line(`${this.style('▸', 'blue')} ${text}`)
  }

  step(text: string): void {
    this.line(`  ${this.style('·', 'dim')} ${text}`)
  }

  /**
   * A fatal error, in the shape the config package already uses: what went
   * wrong, then how to fix it. Goes to stderr so `sitebot validate > out.json`
   * still shows the failure.
   */
  fatal(message: string, fix?: string): void {
    this.errorLine(`${this.style('✗', 'red')} ${message}`)
    if (fix !== undefined) this.errorLine(`  ${this.style(fix, 'dim')}`)
  }
}

/** Milliseconds as something a human reads at a glance. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

/** `1204` → `1,204`. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}
