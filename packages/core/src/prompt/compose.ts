import { isMcpImport, type SiteBotConfig } from '@sitebot/config'
import type { Identity, PageContext } from '../types.js'
import { randomDelimiterId, untrustedBlock } from './untrusted.js'
import { substituteVariables } from './variables.js'

/**
 * Prompt composition — docs/04-providers-and-engine.md §5, ordering fixed by
 * docs/02-configuration.md §5.
 *
 * `composePrompt` is a pure function of its input: same input, same string.
 * That is what makes it snapshot-testable, and it is also what makes prompt
 * caching work — see the note on block ordering at the bottom of this file.
 */

/** One retrieved chunk. */
export interface KnowledgeSnippet {
  id: string
  title?: string
  url?: string
  text: string
  score?: number
}

export interface ComposeContext {
  pageContext?: PageContext | null
  identity?: Identity | null
}

export interface ComposeInput {
  config: SiteBotConfig
  ctx?: ComposeContext
  /** Resolved retrieval mode. Only `always` and `hybrid` inline knowledge. */
  retrieval?: 'tool' | 'always' | 'hybrid'
  documents?: readonly KnowledgeSnippet[]
  /**
   * Injected in place of the knowledge block when retrieval ran but found
   * nothing — the explicit "no relevant documentation" note of docs/06 §3.8,
   * which is what stops the model confabulating.
   */
  note?: string
  /**
   * Fixed delimiter id. Supplied by tests for stable snapshots; production
   * leaves it undefined so every request gets a fresh one (docs/08 §4).
   */
  delimiterId?: string
}

export interface ComposedPrompt {
  text: string
  /** Stable prefix groups, followed by volatile page/retrieval content. */
  segments: { text: string; cacheable: boolean }[]
  /** Present blocks, in order. Asserted by the ordering tests. */
  blocks: string[]
  delimiterId: string
  /** `{{placeholders}}` with no configured value. Surfaced by `sitebot validate`. */
  missingVariables: string[]
}

const PAGE_SOURCE = 'The text below was extracted from the web page the user is currently viewing.'
const KNOWLEDGE_SOURCE =
  "The text below was retrieved from this site's indexed content by a search."

export function composePrompt(input: ComposeInput): ComposedPrompt {
  const { config } = input
  const ctx = input.ctx ?? {}
  const delimiterId = input.delimiterId ?? randomDelimiterId()

  const blocks: string[] = []
  const parts: string[] = []
  const push = (name: string, text: string | undefined): void => {
    if (text === undefined || text.trim() === '') return
    blocks.push(name)
    parts.push(text)
  }

  // 1 — the system prompt, with {{variables}} substituted.
  const system = substituteVariables(config.prompt.system ?? '', config.prompt.variables)
  push('system', system.text.trim())

  // 2 — <site_context>: trusted, hand-written by the developer.
  if (config.prompt.includeSiteContext) push('site_context', siteContextBlock(config))

  const baseEnd = parts.length
  // Policy includes identity, so it is reusable only for the same identity.
  push(
    'tool_policy',
    toolPolicyBlock(
      config,
      ctx.identity ?? null,
      input.retrieval ?? (config.mode === 'chat' ? 'always' : 'tool'),
    ),
  )
  push('guardrails', guardrailsBlock(config))
  const stableEnd = parts.length

  // <page_context>: untrusted, after the stable prefix.
  if (config.prompt.includePageContext) {
    push('page_context', pageContextBlock(ctx.pageContext ?? null, delimiterId))
  }

  // <knowledge>: untrusted, inline only when retrieval is always | hybrid.
  const retrieval = input.retrieval ?? (config.mode === 'chat' ? 'always' : 'tool')
  if (retrieval !== 'tool') {
    push('knowledge', knowledgeBlock(input.documents ?? [], delimiterId, input.note))
  }

  return {
    text: parts.join('\n\n'),
    segments: [
      { text: parts.slice(0, baseEnd).join('\n\n'), cacheable: true },
      { text: parts.slice(baseEnd, stableEnd).join('\n\n'), cacheable: true },
      { text: parts.slice(stableEnd).join('\n\n'), cacheable: false },
    ].filter((segment) => segment.text !== ''),
    blocks,
    delimiterId,
    missingVariables: system.missing,
  }
}

// ── block 2 ─────────────────────────────────────────────────────────────────

function siteContextBlock(config: SiteBotConfig): string | undefined {
  const site = config.siteContext
  const lines: string[] = []

  if (site.company !== undefined) lines.push(`Company: ${site.company}`)
  if (site.description !== undefined) lines.push(`Description: ${site.description}`)
  if (site.primaryUrl !== undefined) lines.push(`Website: ${site.primaryUrl}`)
  if (site.supportUrl !== undefined) lines.push(`Support: ${site.supportUrl}`)
  if (site.tone !== undefined) lines.push(`Tone: ${site.tone}`)

  if (site.facts.length > 0) {
    lines.push('Known facts:')
    for (const fact of site.facts) lines.push(` - ${fact}`)
  }
  if (site.routes.length > 0) {
    lines.push('Site sections:')
    for (const route of site.routes) {
      lines.push(
        route.summary === undefined ? ` - ${route.path}` : ` - ${route.path} — ${route.summary}`,
      )
    }
  }
  if (site.glossary.length > 0) {
    lines.push('Glossary:')
    for (const entry of site.glossary) lines.push(` - ${entry.term}: ${entry.definition}`)
  }

  if (lines.length === 0) return undefined
  return `<site_context>\n${lines.join('\n')}\n</site_context>`
}

// ── block 3 ─────────────────────────────────────────────────────────────────

function pageContextBlock(page: PageContext | null, delimiterId: string): string | undefined {
  if (page === null) return undefined

  const facts: string[] = []
  if (page.url !== undefined) facts.push(`URL: ${page.url}`)
  if (page.title !== undefined) facts.push(`Title: ${page.title}`)
  if (page.description !== undefined) facts.push(`Description: ${page.description}`)
  if (page.selection != null && page.selection !== '') {
    facts.push(`The user has selected this text: ${page.selection}`)
  }

  const body = [...facts, ...(page.extract === undefined ? [] : ['', page.extract])].join('\n')
  if (body.trim() === '') return undefined

  return untrustedBlock({
    tag: 'page_context',
    source: PAGE_SOURCE,
    content: body,
    delimiterId,
  })
}

// ── block 4 ─────────────────────────────────────────────────────────────────

function knowledgeBlock(
  documents: readonly KnowledgeSnippet[],
  delimiterId: string,
  note?: string,
): string | undefined {
  if (documents.length === 0 && note === undefined) return undefined
  if (documents.length === 0) return `<knowledge>\n${note}\n</knowledge>`

  const rendered = documents
    .map((doc, index) => {
      const heading = [doc.title, doc.url].filter((part) => part !== undefined).join(' — ')
      return `[${index + 1}] ${heading}\n${doc.text}`
    })
    .join('\n\n')

  return untrustedBlock({
    tag: 'knowledge',
    source: KNOWLEDGE_SOURCE,
    content: rendered,
    delimiterId,
  })
}

// ── block 5 ─────────────────────────────────────────────────────────────────

/**
 * Generated, never hand-written. The identity sentence matters: when a
 * `scope: authenticated` tool is filtered out for an anonymous visitor, the
 * model has to be able to say *why* rather than claim the capability does not
 * exist (docs/08 §3, `auth.mode: optional`).
 */
function toolPolicyBlock(
  config: SiteBotConfig,
  identity: Identity | null,
  retrieval: 'tool' | 'always' | 'hybrid',
): string | undefined {
  const lines: string[] = []

  for (const entry of config.tools) {
    if (isMcpImport(entry) || entry.enabled === false) continue

    const approvalRequired =
      entry.requiresApproval || config.agent.approvalRequired.includes(entry.name)
    if (approvalRequired && config.mode === 'agent') {
      lines.push(`- \`${entry.name}\` requires user approval before it runs.`)
    }
    if (entry.scope === 'authenticated') {
      lines.push(
        identity === null
          ? `- \`${entry.name}\` requires a signed-in user. The current user is not signed in, so it is unavailable — say so rather than guessing.`
          : `- \`${entry.name}\` requires a signed-in user. The current user is signed in as ${identity.sub}.`,
      )
    }
  }

  const knowledgeAvailable =
    config.knowledge.sources.length > 0 && config.knowledge.embedding !== undefined
  // Gated on `knowledgeAvailable` too: with no source configured the knowledge
  // block can never appear, and telling the model to cite [n] results that
  // cannot exist invites it to invent them.
  if (retrieval !== 'tool' && knowledgeAvailable && config.knowledge.retrieval.includeCitations) {
    lines.push('- Cite sources with [n] when you use knowledge results.')
  }
  if (retrieval !== 'always' && knowledgeAvailable && config.knowledge.retrieval.includeCitations) {
    lines.push(
      '- `search_knowledge_base` searches the indexed site content. Cite its results with [n] when you use them.',
    )
  }

  if (config.mode === 'chat' && config.tools.length > 0) {
    lines.push('- Tools available here only read information; none of them change anything.')
  }

  if (lines.length === 0) return undefined
  return `<tool_policy>\n${lines.join('\n')}\n</tool_policy>`
}

// ── block 6 ─────────────────────────────────────────────────────────────────

function guardrailsBlock(config: SiteBotConfig): string | undefined {
  const { guardrails } = config.prompt
  if (!guardrails.refuseOffTopic) return undefined

  const subject = config.siteContext.company ?? config.name
  return [
    '<guardrails>',
    `Only answer questions about ${subject} and this website.`,
    `If a question is unrelated, reply: "${guardrails.offTopicMessage}"`,
    '</guardrails>',
  ].join('\n')
}

/**
 * Why the order is not cosmetic (docs/04 §5, "Caching"):
 *
 * System, site context, tool policy and guardrails form the stable prefix;
 * page context and knowledge change
 * on every request. Providers that support explicit prompt caching cache a
 * *prefix*, so putting the volatile blocks last is what makes the stable part
 * cacheable at all. Reordering these for readability would quietly multiply the
 * input-token bill.
 */
