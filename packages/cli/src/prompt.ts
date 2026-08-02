/**
 * Interactive prompts for `sitebot init`.
 *
 * Built on `node:readline/promises` rather than a prompt library, for the same
 * reason as the argument parser: this runs under `npx` before anything is
 * installed. The three shapes `init` needs are text, select and confirm.
 *
 * Every prompt takes a default, and `Prompter` can be constructed
 * non-interactively — which is what `--yes` and a CI run do. A prompt that
 * cannot be answered in a non-interactive session returns its default rather
 * than hanging on a closed stdin.
 */

import { createInterface, type Interface } from 'node:readline/promises'
import { Ui } from './terminal.js'

export interface Choice<T extends string = string> {
  value: T
  label: string
  hint?: string
}

export interface PrompterOptions {
  ui?: Ui
  /** When false every prompt resolves to its default. */
  interactive?: boolean
  /** Scripted answers, for tests. Consumed in order. */
  answers?: string[]
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export class Prompter {
  private readonly ui: Ui
  private readonly interactive: boolean
  private readonly scripted: string[]
  private rl: Interface | null = null
  private readonly input: NodeJS.ReadableStream
  private readonly output: NodeJS.WritableStream

  constructor(options: PrompterOptions = {}) {
    this.ui = options.ui ?? new Ui()
    this.scripted = [...(options.answers ?? [])]
    this.input = options.input ?? process.stdin
    this.output = options.output ?? process.stdout
    this.interactive =
      options.interactive ??
      (this.scripted.length > 0 || ((this.input as NodeJS.ReadStream).isTTY ?? false))
  }

  get isInteractive(): boolean {
    return this.interactive
  }

  async text(question: string, fallback = ''): Promise<string> {
    const suffix = fallback === '' ? '' : this.ui.style(` (${fallback})`, 'dim')
    const answer = await this.ask(`${question}${suffix}: `)
    return answer === null || answer.trim() === '' ? fallback : answer.trim()
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    const hint = this.ui.style(fallback ? ' (Y/n)' : ' (y/N)', 'dim')
    const answer = await this.ask(`${question}${hint}: `)
    if (answer === null || answer.trim() === '') return fallback
    return /^y(es)?$/i.test(answer.trim())
  }

  /**
   * A numbered list. Numbered rather than arrow-key driven on purpose: raw-mode
   * keypress handling is where a hand-rolled prompt starts breaking across
   * terminals, and typing `2` works identically everywhere, including in the
   * Windows console the config loader has to support anyway.
   */
  async select<T extends string>(
    question: string,
    choices: readonly Choice<T>[],
    fallback: T,
  ): Promise<T> {
    const first = choices[0]
    if (first === undefined) throw new Error('select() needs at least one choice')
    if (!this.interactive) return fallback

    this.ui.line(this.ui.style(question, 'bold'))
    const width = String(choices.length).length
    for (const [index, choice] of choices.entries()) {
      const marker = choice.value === fallback ? this.ui.style('●', 'cyan') : ' '
      const number = this.ui.style(String(index + 1).padStart(width), 'dim')
      const hint = choice.hint === undefined ? '' : this.ui.style(`  ${choice.hint}`, 'dim')
      this.ui.line(` ${marker} ${number}. ${choice.label}${hint}`)
    }

    for (;;) {
      const answer = await this.ask(`Choose 1-${choices.length}: `)
      if (answer === null || answer.trim() === '') return fallback

      const raw = answer.trim()
      const index = Number(raw)
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
        return (choices[index - 1] as Choice<T>).value
      }
      // Accept the value itself too — `sitebot init` piped a provider name is a
      // reasonable thing to script, and rejecting it would be pedantic.
      const byValue = choices.find((choice) => choice.value === raw)
      if (byValue !== undefined) return byValue.value

      this.ui.warn(`"${raw}" is not one of the choices.`)
    }
  }

  close(): void {
    this.rl?.close()
    this.rl = null
  }

  private async ask(question: string): Promise<string | null> {
    if (this.scripted.length > 0) {
      const answer = this.scripted.shift() as string
      this.output.write(`${question}${answer}\n`)
      return answer
    }
    if (!this.interactive) return null

    this.rl ??= createInterface({ input: this.input, output: this.output })
    return await this.rl.question(question)
  }
}
