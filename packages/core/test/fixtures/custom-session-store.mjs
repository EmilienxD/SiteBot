// A `storage.type: custom` module, as a developer would write one — used by
// session-stores.test.ts. It exports a factory; exporting a ready store works too.

export function createStore() {
  const sessions = new Map()
  return {
    async get(id) {
      return sessions.has(id) ? structuredClone(sessions.get(id)) : null
    },
    async set(session) {
      sessions.set(session.id, structuredClone(session))
    },
    async append(id, messages) {
      const now = Date.now()
      const session = sessions.get(id) ?? { id, messages: [], createdAt: now, updatedAt: now }
      const next = { ...session, messages: [...session.messages, ...messages], updatedAt: now }
      sessions.set(id, next)
      return structuredClone(next)
    },
    async delete(id) {
      sessions.delete(id)
    },
  }
}

export const broken = { get() {}, set() {} }
