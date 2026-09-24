# @sitebot/widget

The chat widget for [SiteBot](https://github.com/EmilienxD/SiteBot): a `<site-chat>` custom element with
a launcher and a chat panel, rendered in a closed shadow root so your site's CSS can't reach it. About
13 KB gzipped before the panel opens; the panel is a separate chunk that loads on first open.

## Use it

One script tag, pointing at your chat endpoint:

```html
<script
  type="module"
  src="https://cdn.jsdelivr.net/npm/@sitebot/widget@0.1/dist/sitebot.js"
  data-endpoint="/api/chat"
></script>
```

`@0.1` follows patch releases of 0.1.x; from 1.0 the range becomes `@1`. For an endpoint on another origin, use its full URL and add `data-key` (your config's
`security.publicKey`). Optional attributes: `data-position`, `data-theme`, `data-auto-open`, `nonce`.

## Pin it with SRI

Each release ships `dist/sri.json` with a sha384 hash for every file, and lists the hashes in the release
notes:

```html
<script
  type="module"
  src="https://cdn.jsdelivr.net/npm/@sitebot/widget@1.2.3/dist/sitebot.js"
  integrity="sha384-…"
  crossorigin="anonymous"
></script>
```

`integrity` applies to the entry file only. To verify the lazily loaded chunks as well, self-host the
files from `dist/` and check them against `sri.json`.

## The page API

```js
SiteBot.open()
SiteBot.send('Where is my order?')
SiteBot.registerTool('get_cart', () => ({ items: cart.items }))
SiteBot.identify(jwt)
SiteBot.on('message', (event) => analytics.track(event))
```

React users can use [`@sitebot/react`](https://www.npmjs.com/package/@sitebot/react) instead.

Documentation: [getting started](https://github.com/EmilienxD/SiteBot#try-it) · the widget spec,
[`docs/07-widget.md`](https://github.com/EmilienxD/SiteBot/blob/main/docs/07-widget.md).
