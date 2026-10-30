import type { MetadataRoute } from 'next'

// Public sitemap for this example website.
const base = process.env.SITE_URL ?? 'http://localhost:3000'

export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/bikes', '/service'].map((path) => ({ url: `${base}${path}` }))
}
