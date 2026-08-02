import type { UIMessage } from 'ai'

/**
 * Session storage — docs/01-architecture.md §6 (extension point), docs/02 §10.
 *
 * Four methods, deliberately. Anything richer would make `storage.type: custom`
 * expensive to implement, and every backend we ship (memory, sqlite, redis,
 * postgres) can express these four cheaply.
 */

export interface StoredSession {
  id: string
  messages: UIMessage[]
  createdAt: number
  updatedAt: number
  /**
   * Coarse fingerprint (IP prefix + origin + UA hash) bound on first use.
   * A mismatch starts a new session rather than erroring — docs/08 §6.
   */
  fingerprint?: string
  /** Checkpointed loop state for suspend/resume. Populated in Phase 5. */
  state?: Record<string, unknown>
}

export interface SessionStore {
  get(id: string): Promise<StoredSession | null>
  set(session: StoredSession): Promise<void>
  append(id: string, messages: UIMessage[]): Promise<StoredSession>
  delete(id: string): Promise<void>
  dispose?(): Promise<void>
}

export interface SessionStoreOptions {
  ttlSeconds?: number
  maxMessagesPerSession?: number
  /** Injected in tests so expiry can be exercised without waiting. */
  now?: () => number
}

/**
 * `storage.type: none` — genuinely stateless, and therefore genuinely weaker:
 * the client supplies the whole history, so it can forge an assistant turn.
 * That is documented (docs/08 §6) and is why cross-field rule 2 forbids it in
 * agent mode. It is a real store rather than a `null` special case so that the
 * engine has exactly one code path.
 */
export class NoneSessionStore implements SessionStore {
  async get(): Promise<StoredSession | null> {
    return null
  }
  async set(): Promise<void> {}
  async append(id: string, messages: UIMessage[]): Promise<StoredSession> {
    const time = Date.now()
    return { id, messages, createdAt: time, updatedAt: time }
  }
  async delete(): Promise<void> {}
}

/**
 * In-process store. Single-replica only — the sqlite/redis stores exist for
 * anything real. Expiry is lazy (checked on read) plus a sweep on write, which
 * avoids holding a timer open in a serverless runtime.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly ttlMs: number
  private readonly maxMessages: number
  private readonly now: () => number

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = (options.ttlSeconds ?? 2_592_000) * 1000
    this.maxMessages = options.maxMessagesPerSession ?? 100
    this.now = options.now ?? (() => Date.now())
  }

  private expired(session: StoredSession): boolean {
    return this.now() - session.updatedAt > this.ttlMs
  }

  async get(id: string): Promise<StoredSession | null> {
    const session = this.sessions.get(id)
    if (session === undefined) return null
    if (this.expired(session)) {
      this.sessions.delete(id)
      return null
    }
    return structuredClone(session)
  }

  async set(session: StoredSession): Promise<void> {
    this.sweep()
    this.sessions.set(session.id, {
      ...structuredClone(session),
      messages: session.messages.slice(-this.maxMessages),
      updatedAt: this.now(),
    })
  }

  async append(id: string, messages: UIMessage[]): Promise<StoredSession> {
    const existing = await this.get(id)
    const time = this.now()
    const next: StoredSession = existing ?? {
      id,
      messages: [],
      createdAt: time,
      updatedAt: time,
    }
    next.messages = [...next.messages, ...messages].slice(-this.maxMessages)
    next.updatedAt = time
    await this.set(next)
    return next
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id)
  }

  /** Drop expired sessions. Called on write so the map cannot grow unbounded. */
  private sweep(): void {
    for (const [id, session] of this.sessions) {
      if (this.expired(session)) this.sessions.delete(id)
    }
  }

  /** Test/introspection helper. Not part of the `SessionStore` contract. */
  get size(): number {
    return this.sessions.size
  }
}
