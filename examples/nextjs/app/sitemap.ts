import type { MetadataRoute } from 'next'

// What `pnpm ingest` reads to build the knowledge index (chatbot.config.yaml).
const base = process.env.SITE_URL ?? 'http://localhost:3000'

export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/bikes', '/service'].map((path) => ({ url: `${base}${path}` }))
}
