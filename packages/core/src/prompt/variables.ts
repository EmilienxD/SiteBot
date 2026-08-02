/**
 * `{{variables}}` in `prompt.system` — docs/02-configuration.md §5.
 *
 * Note the deliberate asymmetry with `${env.*}`: env interpolation happens at
 * config load and is tracked so secrets can be stripped from the public config,
 * whereas `{{variables}}` are substituted here, at prompt time. Keeping the two
 * syntaxes distinct is what makes "a secret can never be templated into the
 * browser-visible config" a structural property rather than a review habit.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g

export interface SubstituteResult {
  text: string
  /** Placeholders with no matching variable, in first-seen order. */
  missing: string[]
}

/**
 * Substitute `{{name}}` from `variables`.
 *
 * An unknown placeholder is left in place rather than blanked. A prompt that
 * reads "contact {{supportEmail}}" is an obvious bug the first time anyone
 * looks at it; a prompt that reads "contact " is a mystery.
 */
export function substituteVariables(
  text: string,
  variables: Record<string, string>,
): SubstituteResult {
  const missing: string[] = []
  const out = text.replace(PLACEHOLDER, (match, name: string) => {
    const value = variables[name]
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return match
    }
    return value
  })
  return { text: out, missing }
}
