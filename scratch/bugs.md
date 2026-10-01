## Verification completed — 2026-10-01

All five reported bugs are fixed and verified. The remaining e2e startup failure was a port collision with another application on port 8000; the test site now uses port 4318.

Browser testing exposed an additional approval handoff regression: approved client tools ran on the page but never posted their results. This is fixed, with coverage for completion after approval and reload. Resolved cards restore keyboard focus, and Jump to latest has a separate row below the transcript.

History now follows the configured session scope, so a new per-tab session does not show another tab's conversation. Step, token, and active server-time limits carry across client-tool requests; waiting for approval does not consume active server time. Renewed approvals after Retry use the new run ID and a fresh step count. The docs, generated reference, and schema snapshot match this behavior.

Final verification:

- `pnpm test`: 953 passed, 1 skipped.
- `pnpm test:security`: 56 passed.
- `pnpm e2e --workers=4`: all 55 passed, including accessibility and existing visual snapshots.
- Build, typecheck, lint, formatting, bundle-size, and package checks pass.
- Chrome DevTools MCP: approval, denial, reload, real checkpoint expiry, Retry, subsequent chat, and the five-call loop limit verified. Desktop and mobile screenshots inspected. The real CLI's `--inspect` output contains stream frames.

Provider calls used the deterministic offline model. No live provider check or deployment was performed. Changes are uncommitted.

## Previous agent report

Fix the bugs reported by the previous agents. try in browser with chrome devtools mcp.

1. Expired approval breaks the conversation (blocker). Approvals expire after 15 minutes. After that, the dangling tool call stays in the stored history and every later message fails with AI_MissingToolResultsError (502, "I'm having trouble right now"). There's no "new conversation" button, so the visitor is stuck until the 24 h session expires or they clear site storage. The 410 is thrown in core/src/agent/checkpoint.ts:46; the history reaches the model unchanged at core/src/engine.ts:649. Two related problems:
   - After a reload, the expired card still showed working Approve/Deny buttons.
   - After the 410, its tool chip stays on a spinning "Running".
2. maxSteps doesn't limit client-tool loops. Each client-tool round trip is a new request with a fresh 5-step limit. The model called highlight_section 7 times in a row under maxSteps: 5, and 3 times on another question. The only real cap is the rate limit (30 requests per 5 min).
3. A denied tool shows "Done". widget/src/panel.tsx:665 treats output-denied the same as success, and there's no "Denied" label. Here the model also falsely said "I've pre-filled the form" after the denial. The server stored the denial correctly, so that sentence is the model's fault, but the "Done" chip backs up the false claim.
4. sitebot dev --inspect logs nothing. tapStream in cli/src/commands/listener.ts only reads strings and Buffers, but the server writes Uint8Array chunks. The banner says stream events are logged; none were.
5. Minor UI issues:
   - After a reload with a pending approval, the list isn't scrolled to the bottom (the card's buttons were cut off) and Deny isn't focused.
   - The "↓ Jump to latest" chip can cover the last user message.

I hit the usage limit, so I'm stopping here. All five bugs are fixed. Unit tests, typecheck and lint pass, and I checked bugs 1–4 and 5b in Chrome against `sitebot dev --inspect` with the scripted offline model. Bug 5a I couldn't reproduce, and the Playwright e2e suite hasn't been run yet.

**Fixes**

1. **Expired approval breaking the conversation:**
   - The server now closes any tool call that never got a result when a new message (or a Retry) arrives. The model is told the action did not run, the abandoned run is dropped, and a late attempt to approve it gets a 410.
   - In the widget, a 410 turns the card into a **Timed out** chip with no spinner, and Retry now starts a fresh turn, as the spec requires.
   - Sending a new message while a card is waiting marks it **Skipped**. After a reload, a card the server no longer knows about shows as **Timed out**.
   - In the browser: approving a card I had forced to expire gave "This request timed out." with Retry, and the conversation carried on normally afterwards.
2. **`maxSteps` across client-tool round trips:** the step limit now covers the whole run, not each request. With the looping model under `maxSteps: 5`, I saw 4 highlights and then a final answer: 5 model calls in total.
3. **Denied tools showing "Done":** the chip now says **Denied**, including straight after the click. I also changed the denial text the model receives to say plainly that the action was not performed, to discourage false "I've pre-filled the form" replies. It still starts with `user_denied`.
4. **`--inspect` logging nothing:** the stream tap now decodes `Uint8Array` chunks. The real server now logs every stream event.
5. **UI issues:**
   - "Jump to latest" was positioned 132px up from the bottom of the whole panel, so it floated over the conversation. It now sits on the bottom edge of the message list. Confirmed in the browser.
   - I couldn't reproduce the reload scroll/focus problem in any viewport, with throttling, or with the cached history cleared. Deny was always focused. As a defensive fix, the list now stays scrolled to the bottom when anything changes its size, not only when a message arrives.

New regression tests cover bugs 1, 2 and 4, and they fail on the old code. Chip labels and the controller changes also have new tests. Overall: 938 tests pass and 1 is skipped.

**Still to do**

- **e2e:** `pnpm e2e` timed out twice waiting for its local servers to start. The plain-html server answers fine when I start it by hand. It's probably the express-sidecar static site on port 8000. Nothing ran, so the visual snapshots may need updating for the moved chip.
- **Docs:** `docs/03-protocol.md` §5 rule 3 and `docs/05-tools.md` §7 still describe the denial reason as just `user_denied`. `docs/04` should say the step limit covers the whole run.
- **Cleanup:** my test server is still running on port 4400, and its config files are in `%TEMP%\sitebot-manual`.

**Other things I noticed, not changed**

- After you answer an approval card, keyboard focus is lost instead of going back to the message box.
- The widget keeps history in `localStorage` but the session id in `sessionStorage`. A new tab therefore shows the old conversation under a new session. Stale cards in that case are now handled.
- The token and time limits still reset on every round trip; only the step limit is fixed.
- There's still no "new conversation" button. Visitors are no longer stuck without one.

Nothing is committed.
