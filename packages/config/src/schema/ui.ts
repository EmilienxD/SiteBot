import { z } from 'zod'
import { GlobSchema, SelectorSchema, ToolNameSchema } from './primitives.js'

export const POSITIONS = ['bottom-right', 'bottom-left'] as const
export const ISOLATION_MODES = ['shadow', 'iframe'] as const
export const THEME_MODES = ['auto', 'light', 'dark'] as const
export const LAUNCHER_ICONS = ['sparkle', 'chat', 'question', 'custom'] as const
export const SESSION_SCOPES = ['tab', 'browser'] as const
export const SUGGESTION_ACTION_TYPES = ['send', 'navigate', 'tool', 'link'] as const

/** The `ui` block is sent verbatim to the browser. Nothing here is a secret. */

export const OffsetSchema = z.strictObject({
  x: z.number().int().default(24),
  y: z.number().int().default(24),
})

export const BadgeSchema = z.strictObject({
  enabled: z.boolean().default(false),
  text: z.string().default(''),
})

export const LauncherSchema = z.strictObject({
  label: z
    .string()
    .optional()
    .describe('Turns the circular launcher into a pill. Omit for icon-only.'),
  icon: z.enum(LAUNCHER_ICONS).default('sparkle'),
  iconUrl: z.string().optional(),
  showAfterMs: z.number().int().min(0).default(0),
  hideOnPaths: z.array(GlobSchema).default([]),
  badge: BadgeSchema.prefault({}),
})

export const PanelSchema = z.strictObject({
  width: z.number().int().positive().default(400),
  height: z.number().int().positive().default(640),
  title: z.string().optional().describe('Defaults to the top-level `name`.'),
  avatarUrl: z.string().optional(),
  showAvatar: z.boolean().default(true),
  showClose: z.boolean().default(true),
  openOnFirstVisit: z.boolean().default(false),
  rememberOpenState: z.boolean().default(true),
})

/**
 * Design tokens — docs/07-widget.md §4. Only the subset a developer is expected
 * to brand; the rest of the token set is derived at runtime.
 */
export const ThemeSchema = z.strictObject({
  mode: z.enum(THEME_MODES).default('auto'),
  primary: z.string().optional(),
  onPrimary: z
    .string()
    .optional()
    .describe('Computed from `primary` by luminance when omitted, so contrast holds.'),
  surface: z.string().optional(),
  text: z.string().optional(),
  muted: z.string().optional(),
  bubbleAssistant: z.string().optional(),
  bubbleUser: z.string().optional(),
  radius: z.number().int().min(0).optional(),
  font: z.string().optional().describe('inherit | system | a CSS font-family.'),
  shadow: z.string().optional(),
})

export const SuggestionActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('send'), text: z.string().min(1) }),
  z.strictObject({ type: z.literal('navigate'), path: z.string().min(1) }),
  z.strictObject({
    type: z.literal('tool'),
    tool: ToolNameSchema,
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({ type: z.literal('link'), url: z.string().min(1) }),
])

export const SuggestionSchema = z.strictObject({
  label: z.string().min(1),
  action: SuggestionActionSchema,
})

export const MessagesSchema = z.strictObject({
  greeting: z.string().optional(),
  placeholder: z.string().default('Ask a question…'),
  suggestions: z.array(SuggestionSchema).default([]),
  suggestionsPersist: z
    .boolean()
    .default(false)
    .describe('Keep the pills visible after the first user message.'),
  errorMessage: z.string().default('Something went wrong. Please try again.'),
  emptyStateAfterMs: z.number().int().min(0).default(0),
})

export const FooterSchema = z.strictObject({
  text: z.string().default(''),
  linkText: z.string().optional(),
  linkUrl: z.string().optional(),
})

export const BehaviourSchema = z.strictObject({
  streaming: z.boolean().default(true),
  showTypingIndicator: z.boolean().default(true),
  showReasoning: z
    .boolean()
    .default(false)
    .describe("Reveal the model's reasoning parts in a disclosure."),
  markdown: z.boolean().default(true),
  allowFileUpload: z.boolean().default(false),
  persistHistory: z
    .boolean()
    .default(true)
    .describe('Cache the last 50 messages in localStorage for instant restore.'),
  resetOnNavigate: z.boolean().default(false),
  sound: z.boolean().default(false),
  sessionScope: z
    .enum(SESSION_SCOPES)
    .default('tab')
    .describe('tab uses sessionStorage; browser uses localStorage.'),
  navigateAllowlist: z
    .array(GlobSchema)
    .default([])
    .describe('Extra paths the navigate client tool may target, beyond siteContext.routes.'),
})

/**
 * Page-context extraction controls — docs/03-protocol.md §10, docs/06 §2.
 * `excludePaths` is the switch for routes the assistant must not see at all.
 */
export const PageContextSchema = z.strictObject({
  excludePaths: z.array(GlobSchema).default([]),
  redactSelectors: z.array(SelectorSchema).default(['input', '[data-private]', '.pii']),
  readSelectorDenylist: z
    .array(SelectorSchema)
    .default(['input[type=password]', '[data-sensitive]', 'iframe']),
})

export const UiExtractSchema = z.strictObject({
  selector: SelectorSchema.default('main, article, [role="main"]'),
  strip: z.array(SelectorSchema).default([]),
})

export const A11ySchema = z.strictObject({
  launcherAriaLabel: z.string().default('Open chat assistant'),
  panelAriaLabel: z.string().default('Chat assistant'),
})

export const UiSchema = z
  .strictObject({
    position: z.enum(POSITIONS).default('bottom-right'),
    offset: OffsetSchema.prefault({}),
    zIndex: z.number().int().default(2_147_483_000),
    isolation: z.enum(ISOLATION_MODES).default('shadow'),
    launcher: LauncherSchema.prefault({}),
    panel: PanelSchema.prefault({}),
    theme: ThemeSchema.prefault({}),
    messages: MessagesSchema.prefault({}),
    footer: FooterSchema.optional(),
    behaviour: BehaviourSchema.prefault({}),
    pageContext: PageContextSchema.prefault({}),
    extract: UiExtractSchema.prefault({}),
    a11y: A11ySchema.prefault({}),
    locale: z.string().default('auto'),
    strings: z
      .record(z.string(), z.record(z.string(), z.string()))
      .default({})
      .describe('Per-locale overrides, keyed by BCP-47 tag.'),
  })
  .describe(
    'Fully public — everything here is served by GET /api/chat/config. Never put a secret in this block.',
  )

export type Suggestion = z.output<typeof SuggestionSchema>
export type Ui = z.output<typeof UiSchema>
