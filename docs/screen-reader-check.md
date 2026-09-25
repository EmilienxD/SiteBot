# Manual screen-reader check

axe-core (`e2e/a11y.spec.ts`) verifies the widget's markup in every state. It can't verify what a
screen reader actually *says*, and above all whether a streamed answer is announced once, as a whole,
rather than word by word ([`07`](./07-widget.md) §8). This is the script for checking that by ear. Run it
before each release on at least:

- NVDA with Chrome or Firefox on Windows;
- VoiceOver with Safari on macOS;
- VoiceOver with Safari on iOS (the mobile sheet).

## Setup

```bash
pnpm install && pnpm build
cd examples/plain-html
SITEBOT_PROVIDER=ollama SITEBOT_MODEL=qwen2.5:14b pnpm dev   # or ANTHROPIC_API_KEY=… pnpm dev
```

Open http://localhost:3000 and use only the keyboard or screen-reader gestures from here on.

## Script

Record **pass** or **fail**, with what was actually heard, for each step.

| #   | Do                                                                    | Expect to hear                                                                                                  |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Tab until the launcher has focus                                      | "Open chat assistant, button, collapsed"                                                                        |
| 2   | Press Enter                                                           | The dialog's name, "Chat assistant", then the message field, "Message, edit text". Focus is in the composer.    |
| 3   | Type "Which coffee for pour-over?" and press Enter                    | Nothing noisy while waiting. If the reply takes over 4 s, "Still working…" once.                                |
| 4   | Wait for the answer to finish streaming                               | The **whole** answer read **once**, after it completes. Fail if it is read word by word or restarts mid-answer.  |
| 5   | Shift+Tab back to the answer's feedback buttons                       | "Helpful, button" and "Not helpful, button"                                                                     |
| 6   | Ask "Where do I find the brewing guides?" on the home page            | Any tool activity announced as a short status ("Running…" / "Done"), not silently                              |
| 7   | Go to /wholesale and ask it to fill the form                          | "Approval required" dialog announced; focus on **Deny**                                                         |
| 8   | Press Enter                                                           | The request is declined (Enter never approves), and the assistant's polite reply is read once                  |
| 9   | Ask again, Tab to **Approve**, press Enter                            | The form fields are filled; the confirmation is read once                                                       |
| 10  | Press Escape in an empty composer                                     | The dialog closes; focus is back on the launcher: "Open chat assistant, button, collapsed"                     |
| 11  | Stop the server, reopen, send a message                               | An error is announced once as an alert, with a Retry button reachable by Tab                                    |
| 12  | (iOS) Open the widget on a phone-width screen                         | The sheet fills the screen; swiping never reaches the page behind it; "Back, button" closes it                  |

## When a step fails

File it with the screen reader and browser versions, the step number, and what was heard. The usual
culprits are in `packages/widget/src/panel.tsx`:

- the message list's `aria-live` / `aria-busy` pair, for steps 3–4;
- `role="status"` on the tool chips, for step 6;
- the approval card's focus handling, for steps 7–8.
