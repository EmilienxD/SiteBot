// Copies the widget bundle into public/widget/ so Workers static assets serve
// it next to the page. Once the widget is on a CDN you can drop this and load
// it from there instead.
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const from = dirname(createRequire(import.meta.url).resolve('@sitebot/widget/sitebot.js'))
const to = new URL('../public/widget/', import.meta.url)
await mkdir(to, { recursive: true })
for (const file of await readdir(from))
  if (file.endsWith('.js')) await copyFile(join(from, file), new URL(file, to))
