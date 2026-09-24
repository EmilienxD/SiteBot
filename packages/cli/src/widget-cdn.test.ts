import { describe, expect, it } from 'vitest'
import { WIDGET_CDN_URL, widgetCdnUrl } from './init/templates.js'

describe('widgetCdnUrl', () => {
  it('pins to the major version from 1.0 on', () => {
    expect(widgetCdnUrl('1.4.2')).toBe(
      'https://cdn.jsdelivr.net/npm/@sitebot/widget@1/dist/sitebot.js',
    )
  })

  it('pins to the minor on 0.x, where a minor bump may break', () => {
    // A hard-coded `@1` would 404 on every 0.x release.
    expect(widgetCdnUrl('0.1.0')).toContain('@sitebot/widget@0.1/')
    expect(widgetCdnUrl('0.3.7')).toContain('@sitebot/widget@0.3/')
  })

  it('follows the version this CLI was released with', () => {
    expect(WIDGET_CDN_URL).toMatch(/@sitebot\/widget@\d+(\.\d+)?\/dist\/sitebot\.js$/)
  })
})
