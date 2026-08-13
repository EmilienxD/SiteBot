import type { ResolvedConfig, ToolEntry } from '@sitebot/config'
import { isMcpImport } from '@sitebot/config'

export type ToolLintSeverity = 'info' | 'warning'
export interface ToolLintFinding {
  rule: string
  severity: ToolLintSeverity
  path: string
  message: string
}

export function lintTools(config: ResolvedConfig): ToolLintFinding[] {
  const findings: ToolLintFinding[] = []
  const tools = config.tools.filter(
    (entry): entry is Exclude<ToolEntry, { from: 'mcp' }> =>
      !isMcpImport(entry) && entry.enabled !== false,
  )
  tools.forEach((entry, index) => {
    const description = entry.description ?? ''
    if (description.length < 20)
      findings.push({
        rule: 'tool/description-too-short',
        severity: 'warning',
        path: `tools[${index}].description`,
        message: 'Tool descriptions should be at least 20 characters.',
      })
    if (!/\buse when\b/i.test(description))
      findings.push({
        rule: 'tool/no-usage-guidance',
        severity: 'info',
        path: `tools[${index}].description`,
        message: 'Add a “Use when…” clause so the model knows when to call this tool.',
      })
    const properties =
      (entry.parameters as { properties?: Record<string, { description?: unknown }> }).properties ??
      {}
    for (const [name, property] of Object.entries(properties))
      if (typeof property.description !== 'string' || property.description.trim() === '')
        findings.push({
          rule: 'tool/param-undocumented',
          severity: 'warning',
          path: `tools[${index}].parameters.properties.${name}.description`,
          message: `Parameter "${name}" needs a description.`,
        })
    if (
      !/^(get|list|find|search|check|create|update|delete|submit|send|set|read|write|open|close|navigate|highlight|fill|copy|collect|handoff|calculate|run|fetch|resolve|load|record|save|remove|clear|verify|validate|ask|show|export|import|refresh|reset|add|remove|start|stop|cancel|approve|deny)(_|$)/i.test(
        entry.name,
      )
    )
      findings.push({
        rule: 'tool/name-not-verb',
        severity: 'info',
        path: `tools[${index}].name`,
        message: 'Tool names should start with a verb-like token.',
      })
  })
  for (let left = 0; left < tools.length; left += 1)
    for (let right = left + 1; right < tools.length; right += 1) {
      const similarity = cosineSimilarity(
        tokens(tools[left]?.description ?? ''),
        tokens(tools[right]?.description ?? ''),
      )
      if (similarity > 0.85)
        findings.push({
          rule: 'tool/overlapping-tools',
          severity: 'warning',
          path: `tools[${right}].description`,
          message: `Tool descriptions overlap heavily with "${tools[left]?.name}".`,
        })
    }
  return findings
}

function tokens(value: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}
function cosineSimilarity(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (const [token, count] of left) {
    dot += count * (right.get(token) ?? 0)
    leftNorm += count * count
  }
  for (const count of right.values()) rightNorm += count * count
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm)
}
