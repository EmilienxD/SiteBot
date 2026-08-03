/**
 * URL helpers shared by the HTTP sources.
 *
 * Two conventions that matter for correctness: host comparison is
 * protocol-agnostic (a redirect from http to https of the same host is still
 * "the same site"), and glob semantics are the *config* subset — `**` crosses
 * directories, `*` does not, nothing else is magic — matching the widget's
 * page-context glob rule so a selector that works in the browser behaves the
 * same at crawl time.
 */

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1)
    }
    return parsed.href
  } catch {
    return url
  }
}

export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host
  } catch {
    return false
  }
}

export function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**` crosses directories; `**/` also matches zero directories, so
        // `**/*.txt` matches a file at the root.
        if (glob[index + 2] === '/') {
          out += '(?:.*/)?'
          index += 2
        } else {
          out += '.*'
          index++
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '.'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  out += '$'
  return new RegExp(out)
}
