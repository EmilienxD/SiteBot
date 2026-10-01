/**
 * The panel's stylesheet — docs/07-widget.md §5–§6.
 *
 * Shipped in the lazy chunk and appended to the shadow root when the chunk
 * arrives, so the initial payload pays only for the launcher. The tokens it
 * consumes are declared once, in `styles.ts`.
 */
export const panelStyles =
  // ── shell ──────────────────────────────────────────────────────────────────
  '.panel,.panel-frame{position:fixed;right:var(--sb-offset-x);bottom:var(--sb-offset-y);width:min(var(--sb-panel-w),calc(100vw - 2 * var(--sb-offset-x)));height:min(var(--sb-panel-h),calc(100dvh - 2 * var(--sb-offset-y)));background:var(--sb-surface);color:var(--sb-text);border:1px solid var(--sb-border);border-radius:var(--sb-panel-radius);box-shadow:var(--sb-shadow);animation:sb-panel var(--sb-dur) var(--sb-ease);font-family:var(--sb-font)}' +
  '.panel{display:flex;flex-direction:column;overflow:hidden}.panel-frame{padding:0;overflow:hidden;color-scheme:normal}' +
  '.panel.left,.panel-frame.left{right:auto;left:var(--sb-offset-x)}' +
  '.panel.framed{position:static;width:100%;height:100vh;border:0;border-radius:0;box-shadow:none;animation:none}' +
  '@keyframes sb-panel{from{opacity:0;transform:translateY(12px) scale(.98)}}' +
  // ── header ─────────────────────────────────────────────────────────────────
  '.header{height:64px;flex:0 0 auto;padding:0 var(--sb-pad);display:flex;align-items:center;gap:12px}' +
  '.divider{height:1px;margin:0 var(--sb-pad);background:var(--sb-border);flex:0 0 auto}' +
  '.avatar{width:36px;height:36px;flex:0 0 auto;border-radius:50%;background:var(--sb-primary);color:var(--sb-on-primary);display:grid;place-items:center;font-weight:700;overflow:hidden}' +
  '.avatar img{width:100%;height:100%;object-fit:cover}' +
  '.title{flex:1;min-width:0;font-size:var(--sb-size-title);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.icon-button{width:32px;height:32px;flex:0 0 auto;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--sb-muted);cursor:pointer}' +
  '.icon-button:hover{background:var(--sb-surface-raised);color:var(--sb-text)}.back{display:none;margin-left:-8px}' +
  // ── messages ───────────────────────────────────────────────────────────────
  '.messages{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:20px var(--sb-pad) 12px;display:flex;flex-direction:column}' +
  '.message{display:flex;flex-direction:column;align-items:flex-start;margin-top:calc(var(--sb-gap) * 1.5)}' +
  '.message:first-child{margin-top:0}.message.same-role{margin-top:calc(var(--sb-gap) / 2)}.message.user{align-items:flex-end}' +
  '.bubble{max-width:var(--sb-bubble-max-w);padding:var(--sb-bubble-pad);border-radius:var(--sb-bubble-radius);background:var(--sb-bubble-assistant-bg);color:var(--sb-bubble-assistant-fg);overflow-wrap:anywhere}' +
  '.user .bubble{background:var(--sb-bubble-user-bg);color:var(--sb-bubble-user-fg);white-space:pre-wrap}' +
  '.bubble>:first-child{margin-top:0}.bubble>:last-child{margin-bottom:0}' +
  '.bubble p,.bubble ul,.bubble ol,.bubble blockquote,.bubble pre{margin:0 0 8px}' +
  '.bubble ul,.bubble ol{padding-left:20px}.bubble li+li{margin-top:2px}' +
  '.bubble h1,.bubble h2,.bubble h3,.bubble h4,.bubble h5,.bubble h6{font-size:1em;font-weight:650;margin:10px 0 6px}' +
  '.bubble blockquote{border-left:3px solid var(--sb-pill-border);padding-left:10px;color:var(--sb-muted)}' +
  '.bubble a{color:inherit;text-decoration:underline;text-underline-offset:2px}' +
  '.bubble code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:rgba(127,127,127,.16);border-radius:4px;padding:.08em .3em}' +
  '.markdown-code{max-width:100%;overflow-x:auto;background:rgba(127,127,127,.14);padding:10px 12px;border-radius:8px;white-space:pre}' +
  '.markdown-code code{background:none;padding:0}' +
  '.streaming-caret::after{content:"";display:inline-block;width:6px;height:1em;margin-left:2px;vertical-align:-2px;background:currentColor;opacity:.5;animation:sb-blink 1s steps(2) infinite}' +
  '.attribution{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:calc(var(--sb-size-small) + 1px);color:var(--sb-muted)}' +
  '.attribution .avatar{width:20px;height:20px;font-size:11px}' +
  '.typing{display:flex;gap:4px;padding:15px 18px;width:max-content}' +
  '.typing i{width:6px;height:6px;background:var(--sb-muted);border-radius:50%;animation:sb-dot 1.2s infinite}' +
  '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}' +
  // ── parts ──────────────────────────────────────────────────────────────────
  '.tool-chip{display:inline-flex;gap:6px;align-items:center;margin-top:6px;font-size:var(--sb-size-small);color:var(--sb-muted);padding:4px 10px;border:1px solid var(--sb-border);border-radius:999px;max-width:100%}' +
  '.tool-chip strong{color:var(--sb-text);font-weight:600}.tool-chip.error{color:var(--sb-danger-fg)}' +
  '.spinner{width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sb-spin .8s linear infinite}' +
  '.reasoning{margin-top:6px;font-size:var(--sb-size-small);color:var(--sb-muted);max-width:var(--sb-bubble-max-w)}' +
  '.reasoning summary{cursor:pointer}.reasoning div{white-space:pre-wrap;margin-top:4px}' +
  '.citations{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-width:var(--sb-bubble-max-w)}' +
  '.citation-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--sb-border);border-radius:999px;background:var(--sb-surface);padding:3px 10px 3px 3px;cursor:pointer;max-width:100%}' +
  '.citation-chip:hover{background:var(--sb-surface-raised)}' +
  '.citation-n{display:grid;place-items:center;min-width:19px;height:19px;border-radius:999px;background:var(--sb-primary);color:var(--sb-on-primary);font-size:11px;font-weight:650}' +
  '.citation-title{font-size:var(--sb-size-small);color:var(--sb-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}' +
  '.feedback{display:flex;gap:2px;margin-top:4px;opacity:0;transition:opacity var(--sb-dur)}' +
  '.message:hover .feedback,.feedback:focus-within,.feedback.rated{opacity:1}@media(hover:none){.feedback{opacity:1}}' +
  '.feedback button{width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--sb-muted);cursor:pointer}' +
  '.feedback button:hover,.feedback button[aria-pressed=true]{background:var(--sb-surface-raised);color:var(--sb-text)}' +
  '.card{margin-top:8px;padding:12px 14px;border:1px solid var(--sb-border);border-radius:12px;background:var(--sb-surface);max-width:var(--sb-bubble-max-w);width:100%}' +
  '.card p{margin:6px 0;color:var(--sb-muted);font-size:14px}.card pre{margin:6px 0 0;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}' +
  '.card summary{cursor:pointer;font-size:var(--sb-size-small);color:var(--sb-muted)}' +
  '.risk{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;font-size:11px;font-weight:600;background:var(--sb-surface-raised);color:var(--sb-muted);text-transform:uppercase}' +
  '.risk.high{background:var(--sb-danger-bg);color:var(--sb-danger-fg)}' +
  '.card-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}' +
  '.button{border:1px solid var(--sb-pill-border);border-radius:8px;background:var(--sb-surface);padding:6px 12px;cursor:pointer;font-size:14px}' +
  '.button.primary{background:var(--sb-primary);border-color:var(--sb-primary);color:var(--sb-on-primary)}' +
  '.status{margin-top:8px;font-size:var(--sb-size-small);color:var(--sb-muted)}' +
  '.error{margin-top:12px;padding:10px 12px;border-radius:12px;background:var(--sb-danger-bg);color:var(--sb-danger-fg);font-size:14px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:var(--sb-bubble-max-w)}' +
  '.error .button{padding:3px 10px;font-size:13px;border-color:currentColor;background:transparent}' +
  '.usage{margin-top:8px;font-size:11px;color:var(--sb-muted)}' +
  // A zero-height anchor on the list's bottom edge: the chip rises from there,
  // whatever height the suggestions, composer and footer below it take.
  '.jump-anchor{display:flex;justify-content:center;padding:4px var(--sb-pad) 8px;flex:0 0 auto}' +
  '.jump{white-space:nowrap;color:var(--sb-text);border:1px solid var(--sb-border);background:var(--sb-surface);border-radius:999px;padding:6px 12px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.12);cursor:pointer}' +
  // ── suggestions: right-aligned column, docs/07 §5 ──────────────────────────
  '.suggestions{display:flex;flex-direction:column;align-items:flex-end;gap:10px;padding:4px var(--sb-pad) 12px;flex:0 0 auto}' +
  '.suggestion{border:1px solid var(--sb-pill-border);border-radius:var(--sb-pill-radius);background:var(--sb-pill-bg);color:var(--sb-pill-fg);padding:var(--sb-pill-pad);cursor:pointer;max-width:100%;text-align:right;font-weight:500}' +
  '.suggestion:hover{background:var(--sb-surface-raised)}' +
  // ── composer ───────────────────────────────────────────────────────────────
  '.composer-wrap{padding:4px 12px 8px;flex:0 0 auto}' +
  '.composer{display:flex;align-items:flex-end;gap:8px;background:var(--sb-input-bg);color:var(--sb-input-fg);border-radius:var(--sb-input-radius);padding:6px 6px 6px 14px}' +
  '.composer:focus-within{box-shadow:0 0 0 2px var(--sb-primary)}' +
  '.composer textarea{min-width:0;flex:1;resize:none;max-height:calc(5 * 1.45em + 12px);min-height:32px;border:0;outline:0;background:transparent;color:inherit;padding:6px 0;line-height:1.45;overflow-y:auto}' +
  '.composer textarea::placeholder{color:var(--sb-muted)}.composer textarea:focus-visible{outline:0}' +
  '.send{width:var(--sb-send-size);height:var(--sb-send-size);flex:0 0 auto;display:grid;place-items:center;border:0;border-radius:50%;background:var(--sb-primary);color:var(--sb-on-primary);cursor:pointer;transition:opacity var(--sb-dur)}' +
  '.send:disabled{opacity:.35;cursor:default}' +
  '.attach{display:grid;place-items:center;width:32px;height:32px;cursor:pointer;color:var(--sb-muted)}' +
  '.footer{padding:2px var(--sb-pad) 12px;color:var(--sb-muted);font-size:var(--sb-size-small);text-align:center;flex:0 0 auto}' +
  '.footer a{color:inherit;text-decoration:underline}' +
  '.offline{margin:auto;text-align:center;color:var(--sb-muted);display:flex;flex-direction:column;align-items:center;gap:10px}' +
  '@keyframes sb-dot{0%,60%,100%{opacity:.35}30%{opacity:1;transform:translateY(-3px)}}' +
  '@keyframes sb-spin{to{transform:rotate(360deg)}}@keyframes sb-blink{to{opacity:0}}' +
  // ── mobile sheet, docs/07 §6 ───────────────────────────────────────────────
  '@media(max-width:639px){.panel,.panel.left,.panel-frame,.panel-frame.left{inset:0;width:100vw;height:var(--sb-vh,100dvh);border:0;border-radius:0}' +
  '.panel.framed{height:100vh}.back{display:grid}.close{display:none}' +
  '.header{padding-top:env(safe-area-inset-top);height:calc(64px + env(safe-area-inset-top))}' +
  '.composer textarea{font-size:16px}.footer{padding-bottom:max(14px,env(safe-area-inset-bottom))}}'
