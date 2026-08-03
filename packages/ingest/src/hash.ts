import { createHash } from 'node:crypto'

/** sha256 hex — the one hash the whole pipeline uses. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}
