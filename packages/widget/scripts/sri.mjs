// Writes dist/sri.json: a sha384 Subresource Integrity hash for every file
// the browser loads — the entry and the chunks it imports. Shipped in the
// package as `@sitebot/widget/sri.json` and copied into the release notes,
// so a CDN script tag can be pinned:
//
//   <script type="module" src="https://cdn.jsdelivr.net/npm/@sitebot/widget@1.2.3/dist/sitebot.js"
//           integrity="sha384-…" crossorigin="anonymous"></script>
//
// `integrity` covers only the file it is on. The lazily imported chunks are
// fetched by the entry and are not hash-checked by the browser, which is why
// every file is listed: a self-hoster can verify the whole set.

import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'

const dist = new URL('../dist/', import.meta.url)
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const files = {}
for (const name of (await readdir(dist)).filter((file) => file.endsWith('.js')).sort()) {
  const digest = createHash('sha384')
    .update(await readFile(new URL(name, dist)))
    .digest('base64')
  files[name] = `sha384-${digest}`
}
if (!files['sitebot.js']) throw new Error('dist/sitebot.js is missing — run the build first.')

await writeFile(
  new URL('sri.json', dist),
  `${JSON.stringify({ version, algorithm: 'sha384', files }, null, 2)}\n`,
)
