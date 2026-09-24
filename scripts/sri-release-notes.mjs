#!/usr/bin/env node
// Prints the Markdown appended to the @sitebot/widget GitHub release: the
// sha384 hash of every file, and a ready-to-paste pinned script tag. Reads
// packages/widget/dist/sri.json, written by the widget build.

import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(
  await readFile(new URL('../packages/widget/dist/sri.json', import.meta.url), 'utf8'),
)
const base = `https://cdn.jsdelivr.net/npm/@sitebot/widget@${manifest.version}/dist`

const lines = [
  '',
  '### Subresource Integrity',
  '',
  '| File | Integrity |',
  '| --- | --- |',
  ...Object.entries(manifest.files).map(([file, hash]) => `| \`${file}\` | \`${hash}\` |`),
  '',
  'Pinned script tag:',
  '',
  '```html',
  '<script',
  '  type="module"',
  `  src="${base}/sitebot.js"`,
  `  integrity="${manifest.files['sitebot.js']}"`,
  '  crossorigin="anonymous"',
  '  data-endpoint="/api/chat"',
  '></script>',
  '```',
  '',
  'The same hashes ship in the package as `@sitebot/widget/sri.json`.',
]
process.stdout.write(`${lines.join('\n')}\n`)
