# 07 — Widget

The reference visual is `docs/example-from-ramp-website.png` — the Chili Piper widget on ramp.com. Four details from it are non-obvious and are specified as first-class behaviour below: **attribution sits under the assistant bubble**, **quick replies are right-aligned pills**, **the composer is a filled rounded field with a circular send button**, and **a legal footer sits under the composer**.

---

## 1. Delivery

### Script tag (primary)

```html
<script
  src="https://cdn.jsdelivr.net/npm/@sitebot/widget@1/dist/sitebot.js"
  data-endpoint="/api/chat"
  data-key="pk_live_a1b2c3"
  data-position="bottom-right"
  data-auto-open="false"
  defer
></script>
```

Boot sequence:

1. Script parses its own `data-*` attributes (or reads `window.SiteBotConfig` if present).
2. Defines `<site-chat>` via `customElements.define` (no-op if already defined — double-inclusion is safe).
3. Appends one `<site-chat>` to `document.body`.
4. Exposes `window.SiteBot` immediately, with a queued API so calls before boot are not lost.
5. Fetches `GET /api/chat/config`, renders the launcher after `ui.launcher.showAfterMs`.

The panel's Preact tree is **lazy** — only the launcher renders until first open, then the chat chunk is dynamically imported. First paint cost is a button.

### ESM / React

```js
import { defineSiteBot } from '@sitebot/widget'
defineSiteBot({ endpoint: '/api/chat', publicKey: 'pk_live_…' })
```

```jsx
import { ChatWidget } from '@sitebot/react'
;<ChatWidget endpoint="/api/chat" publicKey="pk_live_…" onEvent={handle} />
```

### Bundle budget (CI-enforced)

| Chunk              | Budget           |
| ------------------ | ---------------- |
| Launcher (initial) | ≤ 12 KB gzip     |
| Panel (lazy)       | ≤ 18 KB gzip     |
| **Total**          | **≤ 25 KB gzip** |

Preact + `@preact/signals` ≈ 6 KB of that. Markdown rendering uses a ~3 KB subset renderer, not `marked`/`remark`.

---

## 2. Isolation

Default `ui.isolation: shadow`.

```
document.body
└── <site-chat>                       position: fixed; inset: auto; z-index: <configured>
    └── #shadow-root (mode: "closed")
        ├── <style>                   all component CSS, inlined at build
        ├── <button class="launcher">
        └── <div class="panel" role="dialog" aria-modal="false">
```

Why closed shadow root: the host page's CSS cannot reach in, _and_ the host page's JS cannot reach in either — which matters because a buggy host script doing `document.querySelectorAll('button').forEach(...)` would otherwise mangle our UI. All legitimate interaction goes through `window.SiteBot`.

**Host-page defences we must still apply**, since Shadow DOM does not protect against everything:

| Risk                                          | Mitigation                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Inherited `font-size`, `color`, `line-height` | `:host { all: initial }` then re-establish our own base                                                                                |
| Host `* { box-sizing }` etc.                  | Irrelevant — does not cross the boundary                                                                                               |
| Host CSS targeting `site-chat` directly       | We set critical host styles with `!important` in the element's inline style                                                            |
| `z-index` wars                                | Default `2147483000`; configurable                                                                                                     |
| Host `overflow: hidden` on body when we open  | We never modify `body` styles except an opt-in scroll lock on mobile                                                                   |
| CSP blocking inline styles                    | Bundle ships a `<style>` element, not `style=` attributes; document the `style-src 'unsafe-inline'` requirement and offer `data-nonce` |

`ui.isolation: iframe` swaps the panel into a same-origin `<iframe srcdoc>` with `postMessage` bridging, for sites whose CSP forbids inline styles or whose JS is genuinely hostile. The launcher stays in the shadow root either way. Client tools still work — the bridge forwards them to the parent frame.

---

## 3. Component tree

```
<site-chat>
└── Launcher                       button, always mounted
    ├── Icon | Avatar
    ├── Label (optional)
    └── Badge (optional)

└── Panel                          lazy, mounted on first open
    ├── Header
    │   ├── Avatar
    │   ├── Title
    │   └── CloseButton
    ├── Divider
    ├── MessageList                scroll container, aria-live="polite"
    │   ├── Message[]
    │   │   ├── Bubble             text / markdown parts
    │   │   ├── Attribution        avatar + name, BELOW the bubble (assistant only)
    │   │   ├── ToolChip[]         one per tool part, collapsible
    │   │   ├── ReasoningDisclosure  optional
    │   │   ├── Citations          numbered source chips
    │   │   └── FeedbackRow        thumbs, on hover/focus
    │   ├── ApprovalCard           when a data-approval-request is pending
    │   ├── StatusLine             transient data-status
    │   └── TypingIndicator
    ├── SuggestionRow              right-aligned pills
    ├── Composer
    │   ├── Textarea               auto-grow, 1–5 rows
    │   └── SendButton | StopButton
    └── Footer                     legal text + link
```

---

## 4. Design tokens

Derived from the reference screenshot, expressed as CSS custom properties on `:host`. Every one is overridable from `ui.theme`.

```css
:host {
  /* geometry */
  --sb-panel-w: 400px;
  --sb-panel-h: 640px;
  --sb-panel-radius: 16px;
  --sb-offset-x: 24px;
  --sb-offset-y: 24px;
  --sb-gap: 12px;
  --sb-pad: 20px;

  /* surface */
  --sb-surface: #ffffff;
  --sb-surface-raised: #fafafa;
  --sb-border: rgba(0, 0, 0, 0.08);
  --sb-shadow: 0 12px 48px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.06);

  /* type */
  --sb-font: inherit;
  --sb-text: #18181b;
  --sb-muted: #71717a;
  --sb-size-body: 15px;
  --sb-size-title: 16px;
  --sb-size-small: 12px;
  --sb-leading: 1.45;

  /* brand */
  --sb-primary: #4f46e5;
  --sb-on-primary: #ffffff;

  /* bubbles */
  --sb-bubble-assistant-bg: #f1f1f1;
  --sb-bubble-assistant-fg: #18181b;
  --sb-bubble-user-bg: var(--sb-primary);
  --sb-bubble-user-fg: var(--sb-on-primary);
  --sb-bubble-radius: 16px;
  --sb-bubble-pad: 14px 18px;
  --sb-bubble-max-w: 78%;

  /* pills */
  --sb-pill-bg: #ffffff;
  --sb-pill-fg: #18181b;
  --sb-pill-border: #d4d4d8;
  --sb-pill-radius: 999px;
  --sb-pill-pad: 10px 18px;

  /* composer */
  --sb-input-bg: #f4f4f5;
  --sb-input-radius: 12px;
  --sb-input-pad: 14px 16px;
  --sb-send-size: 32px;

  /* launcher */
  --sb-launcher-size: 56px;
  --sb-launcher-bg: var(--sb-primary);
  --sb-launcher-fg: var(--sb-on-primary);

  /* motion */
  --sb-ease: cubic-bezier(0.16, 1, 0.3, 1);
  --sb-dur: 240ms;
}
```

### Dark mode

`ui.theme.mode: auto` (default) follows `prefers-color-scheme`. Dark values are a second token block under `@media (prefers-color-scheme: dark)` **and** a `:host([data-theme="dark"])` selector, so an explicit config setting always wins over the media query in both directions.

```css
--sb-surface: #18181b;
--sb-text: #fafafa;
--sb-muted: #a1a1aa;
--sb-bubble-assistant-bg: #27272a;
--sb-input-bg: #27272a;
--sb-border: rgba(255, 255, 255, 0.1);
--sb-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
```

**Contrast is validated, not assumed.** A build-time check asserts every foreground/background token pair meets WCAG AA (4.5:1 for body, 3:1 for large text and UI borders) in both themes. When a developer sets a custom `--sb-primary`, the widget computes `--sb-on-primary` automatically by luminance rather than trusting a hand-set value, and `sitebot validate` warns on a failing custom pair.

---

## 5. Layout specifics

### Launcher

56 × 56 circle in the configured corner, `--sb-shadow`. With `ui.launcher.label` set it becomes a pill: icon + label, `height: 48px`, `padding: 0 20px 0 14px`. Entrance: fade + 8 px rise over `--sb-dur`, after `showAfterMs`. Hidden entirely on paths matching `hideOnPaths`.

While the panel is open the launcher morphs to a close affordance on mobile and is hidden behind the panel on desktop.

### Panel

Desktop: `position: fixed`, anchored to the configured corner with `--sb-offset-*`, `width: var(--sb-panel-w)`, `height: min(var(--sb-panel-h), calc(100dvh - 2 * var(--sb-offset-y)))`.

Open animation: opacity 0→1 and `translateY(12px) scale(0.98)` → `none`, `--sb-dur`, `--sb-ease`. Respects `prefers-reduced-motion` by dropping to a 1-frame fade.

### Header

`height: 64px`, `padding: 0 var(--sb-pad)`, flex row. Avatar 36 px circle. Title `--sb-size-title` / 600. Close button 32 px hit target with a 20 px glyph, `aria-label` from `ui.a11y`. A 1 px `--sb-border` rule sits below the header, inset by `--sb-pad` on both sides — matching the reference.

### Messages

- Assistant bubble: left-aligned, `--sb-bubble-assistant-bg`, `--sb-bubble-radius`, `--sb-bubble-pad`, `max-width: var(--sb-bubble-max-w)`.
- User bubble: right-aligned, `--sb-bubble-user-bg`, same geometry.
- **Attribution row** sits _below_ the assistant bubble: 20 px avatar + name in `--sb-muted` at `--sb-size-small + 1`, `margin-top: 8px`. Only rendered on the assistant's _last_ bubble in a consecutive run, so a multi-part answer shows one attribution rather than three.
- Consecutive same-role bubbles collapse to `--sb-gap / 2` spacing; role changes use full `--sb-gap * 1.5`.
- Markdown: paragraphs, bold/italic, inline code, fenced code with horizontal scroll, links (`rel="noopener noreferrer"`, `target="_blank"`), ordered/unordered lists, blockquote. **No raw HTML, no images from model output** — the renderer escapes everything and only emits the whitelisted node types. This is an XSS boundary, not a styling choice.
- Long messages: the scroll container auto-follows the stream only while the user is within 40 px of the bottom. Scrolling up cancels follow and reveals a "Jump to latest" chip.

### Suggestion pills

Right-aligned column, `align-items: flex-end`, `gap: 10px`, each pill sized to its content. `--sb-pill-*` tokens. Hover raises to `--sb-surface-raised`; focus shows a 2 px `--sb-primary` ring.

Right alignment is deliberate — it reads as "things _you_ could say", visually grouping with the user's own messages rather than the assistant's. This mirrors the reference and is worth preserving.

Behaviour by `action.type`:

| `type`     | Effect                                      |
| ---------- | ------------------------------------------- |
| `send`     | Sends `text` as a user message              |
| `navigate` | Navigates the host page to `path`           |
| `tool`     | Invokes a named tool via a hidden user turn |
| `link`     | Opens `url` in a new tab                    |

Pills disappear after the first user message unless `ui.messages.suggestionsPersist: true`. The server may replace them at any time via a `data-suggestions` part.

### Composer

Filled field, `--sb-input-bg`, `--sb-input-radius`, `--sb-input-pad`. Auto-growing textarea from 1 to 5 rows, then internal scroll. Placeholder from `ui.messages.placeholder`. Circular send button `--sb-send-size` on the right, inside the field, with an up-arrow glyph; disabled and dimmed while empty. During streaming it becomes a Stop button (square glyph) that aborts the request.

Keys: `Enter` sends, `Shift+Enter` newlines, `Escape` closes the panel (or blurs the textarea first if it has content), `↑` on an empty composer recalls the last user message for editing.

### Footer

Centered, `--sb-size-small`, `--sb-muted`, `padding: 10px var(--sb-pad) 14px`. Text from `ui.footer.text`, followed by `ui.footer.linkText` as an underlined link to `linkUrl`. Omitted entirely when `ui.footer` is unset. A compliance-driven element — recording notices and privacy links belong here, exactly as in the reference.

---

## 6. Responsive behaviour

| Breakpoint | Layout                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 640 px   | Floating panel as specified                                                                                                           |
| < 640 px   | Full-screen sheet: `inset: 0`, `border-radius: 0`, header gains a back-chevron, `dvh` units throughout, body scroll locked while open |

Mobile specifics:

- `100dvh` not `100vh`, so the iOS URL bar does not clip the composer.
- `visualViewport` resize listener keeps the composer above the on-screen keyboard.
- `font-size: 16px` on the textarea to prevent iOS auto-zoom.
- Safe-area insets: `padding-bottom: max(14px, env(safe-area-inset-bottom))`.
- Launcher respects `env(safe-area-inset-*)` in its offsets.

---

## 7. State machine

```
idle ──send──▶ submitted ──first token──▶ streaming ──finish──▶ idle
  ▲               │                          │
  │               └──error──▶ error ─────────┘
  │                                          │
  └──────────────────────── abort ───────────┘

streaming ──data-approval-request──▶ awaiting-approval ──decision──▶ submitted
streaming ──data-client-tool-call──▶ executing-client-tool ──result──▶ submitted
```

**`submitted` must be visible.** The gap between hitting Enter and the first token is where a chat feels broken. On entering `submitted` the widget immediately renders the user bubble and a typing indicator; if no token arrives within 4 s it adds "Still working…". Never a dead input.

Per-state affordances:

| State                   | Composer | Send button               | Other                      |
| ----------------------- | -------- | ------------------------- | -------------------------- |
| `idle`                  | enabled  | send, disabled when empty | —                          |
| `submitted`             | enabled  | stop                      | typing indicator           |
| `streaming`             | enabled  | stop                      | text streams, cursor caret |
| `awaiting-approval`     | enabled  | send                      | approval card focused      |
| `executing-client-tool` | enabled  | stop                      | tool chip spinner          |
| `error`                 | enabled  | send                      | error bubble with Retry    |

Queued sends: typing and sending during `streaming` aborts the current run and starts a new one — matching what users actually expect.

---

## 8. Accessibility

Non-negotiable, and cheap to get right at build time rather than retrofit.

- Launcher: `<button>`, `aria-label` from `ui.a11y.launcherAriaLabel`, `aria-expanded`, `aria-controls`.
- Panel: `role="dialog"`, `aria-modal="false"` on desktop (the page stays usable), `aria-modal="true"` on the mobile full-screen sheet, `aria-label` from config.
- Focus: moves to the composer on open; returns to the launcher on close. Focus is trapped only in the mobile sheet and in the approval card.
- `Escape` closes.
- Message list: `aria-live="polite"`, `aria-relevant="additions"`. Streaming deltas are **not** announced token-by-token — the live region updates once per completed message part, otherwise screen readers become unusable.
- Every icon-only control has an accessible name.
- Visible focus rings everywhere; `:focus-visible`, never `outline: none`.
- Approval card: `role="alertdialog"`, focus trapped, Approve is **not** the default Enter action.
- Colour is never the sole carrier of meaning — tool states and errors carry icons and text.
- `prefers-reduced-motion` honoured on every transition.
- Target: axe-core clean, verified in CI via Playwright.

---

## 9. Persistence and identity

- `sessionId`: ULID in `sessionStorage` (per tab). Configurable to `localStorage` for cross-tab continuity via `ui.behaviour.sessionScope`.
- History: when `ui.behaviour.persistHistory: true`, the last 50 messages are cached in `localStorage` under a key namespaced by `publicKey`, for instant restore on reload. **Server-side history remains authoritative** — the cache is a paint optimisation, never a source of truth for the model.
- Open/closed state persisted when `ui.panel.rememberOpenState`.
- `SiteBot.identify(jwt)` stores the token in memory only, never in storage.
- `SiteBot.reset()` clears the session ID, local cache, and identity, and starts fresh.
- All storage keys are prefixed `sitebot:<publicKey>:` so multiple deployments on one domain do not collide.

---

## 10. Failure and degradation

| Condition                                        | Behaviour                                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `/config` fetch fails                            | Launcher renders with built-in defaults; panel shows a retry state on open                                                        |
| Network drop mid-stream                          | One automatic `resume` retry; then an error bubble with manual Retry                                                              |
| `429`                                            | Error bubble with the `Retry-After` countdown; composer disabled until it elapses                                                 |
| `budget_exceeded`                                | Friendly message from config; composer disabled                                                                                   |
| Provider down                                    | "I'm having trouble right now" + Retry; the underlying error is never shown                                                       |
| JS error inside the widget                       | Error boundary renders a minimal recovery UI; the host page is never affected                                                     |
| `localStorage` unavailable (Safari private mode) | Falls back to in-memory; no throw                                                                                                 |
| Shadow DOM unsupported                           | Nothing renders; a single console warning. No polyfill — the target baseline is Chrome/Edge/Firefox/Safari from the last 3 years. |

The widget must **never** throw into the host page. Every entry point — event handlers, the API surface, boot — is wrapped.

---

## 11. Testing

| Area           | Approach                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual         | Playwright screenshots at 4 viewports × light/dark, compared against baselines. Includes a side-by-side with the reference layout.                  |
| Isolation      | Fixture pages with hostile CSS (`* { color: red !important }`, aggressive resets, Tailwind preflight, Bootstrap) — assert the widget is unaffected. |
| Streaming      | Mock SSE server. Assert incremental render, scroll-follow behaviour, stop/abort, resume-after-drop.                                                 |
| Approvals      | Assert the card renders, focus behaviour, deny path, and that Enter does not approve.                                                               |
| Client tools   | Assert allowlist enforcement, navigate restriction, `fill_form` never submits, password fields unreadable.                                          |
| Mobile         | Real-device emulation: keyboard overlay, safe areas, scroll lock, dvh.                                                                              |
| A11y           | axe-core on every state; manual screen-reader script for the streaming live region.                                                                 |
| Bundle size    | `size-limit` in CI; the build fails over budget.                                                                                                    |
| SPA            | Fixture React-Router app; assert `refreshPageContext` updates the context sent.                                                                     |
| Multi-instance | Two script tags on one page → one widget, one warning, no crash.                                                                                    |
