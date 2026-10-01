import type { UIMessage } from './types.js'
const memory = new Map<string, string>()
export function storageKey(publicKey: string, name: string): string {
  return `sitebot:${publicKey}:${name}`
}
function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    const storage = kind === 'local' ? localStorage : sessionStorage
    const probe = '__sitebot_probe__'
    storage.setItem(probe, probe)
    storage.removeItem(probe)
    return storage
  } catch {
    return null
  }
}
export function readValue(key: string, kind: 'local' | 'session'): string | null {
  try {
    const storage = safeStorage(kind)
    return storage ? storage.getItem(key) : (memory.get(`${kind}:${key}`) ?? null)
  } catch {
    return memory.get(`${kind}:${key}`) ?? null
  }
}
export function writeValue(key: string, value: string, kind: 'local' | 'session'): void {
  memory.set(`${kind}:${key}`, value)
  try {
    safeStorage(kind)?.setItem(key, value)
  } catch {
    /* fallback */
  }
}
export function removeValue(key: string): void {
  memory.delete(`local:${key}`)
  memory.delete(`session:${key}`)
  try {
    localStorage.removeItem(key)
  } catch {
    /* unavailable */
  }
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* unavailable */
  }
}
export function readMessages(key: string, kind: 'local' | 'session' = 'local'): UIMessage[] {
  try {
    const parsed = JSON.parse(readValue(key, kind) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
export function writeMessages(
  key: string,
  messages: UIMessage[],
  kind: 'local' | 'session' = 'local',
): void {
  writeValue(key, JSON.stringify(messages.slice(-50)), kind)
}
export function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
