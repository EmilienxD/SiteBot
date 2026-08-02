import type { UIMessage } from 'ai'
const memory = new Map<string, string>()
export function storageKey(publicKey: string, name: string): string { return `sitebot:${publicKey}:${name}` }
function safeStorage(kind: 'local' | 'session'): Storage | null { try { const storage = kind === 'local' ? localStorage : sessionStorage; const probe = '__sitebot_probe__'; storage.setItem(probe, probe); storage.removeItem(probe); return storage } catch { return null } }
export function readValue(key: string, kind: 'local' | 'session'): string | null { try { return safeStorage(kind)?.getItem(key) ?? memory.get(key) ?? null } catch { return memory.get(key) ?? null } }
export function writeValue(key: string, value: string, kind: 'local' | 'session'): void { memory.set(key, value); try { safeStorage(kind)?.setItem(key, value) } catch { /* fallback */ } }
export function removeValue(key: string): void { memory.delete(key); try { localStorage.removeItem(key) } catch { /* unavailable */ }; try { sessionStorage.removeItem(key) } catch { /* unavailable */ } }
export function readMessages(key: string): UIMessage[] { try { const parsed = JSON.parse(readValue(key, 'local') ?? '[]'); return Array.isArray(parsed) ? parsed : [] } catch { return [] } }
export function writeMessages(key: string, messages: UIMessage[]): void { writeValue(key, JSON.stringify(messages.slice(-50)), 'local') }
export function createSessionId(): string { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return `s_${Date.now().toString(36)}${Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('')}` }
