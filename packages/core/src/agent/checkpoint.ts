import type { UIMessage } from 'ai'
import type { SessionStore, StoredSession } from '../session/store.js'
import { argumentHash } from '../tools/approvals.js'

export const CHECKPOINT_TTL_MS = 15 * 60 * 1000

export interface PendingRun {
  runId: string
  responseMessage: UIMessage
  expiresAt: number
}

interface AgentSessionState extends Record<string, unknown> {
  pendingRun?: PendingRun
  approvalGrants?: Record<string, string[]>
}

export class CheckpointError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 410,
  ) {
    super(message)
    this.name = 'CheckpointError'
  }
}

export async function loadPendingRun(
  store: SessionStore,
  sessionId: string,
  runId: string,
  now: number,
): Promise<{ session: StoredSession; pending: PendingRun }> {
  const owner = await store.get(ownerKey(runId))
  const ownerSessionId = owner?.state?.sessionId
  if (typeof ownerSessionId !== 'string' || ownerSessionId !== sessionId) {
    throw new CheckpointError('This action does not belong to this session.', 403)
  }

  const session = await store.get(sessionId)
  const pending = asAgentState(session?.state).pendingRun
  if (session === null || pending?.runId !== runId) {
    throw new CheckpointError('This action is no longer available.', 410)
  }
  if (now > pending.expiresAt) {
    throw new CheckpointError('This action timed out.', 410)
  }
  return { session, pending }
}

export async function savePendingRun(
  store: SessionStore,
  session: StoredSession,
  pending: PendingRun,
): Promise<void> {
  const state = asAgentState(session.state)
  await store.set({ ...session, state: { ...state, pendingRun: pending } })
  const time = Date.now()
  await store.set({
    id: ownerKey(pending.runId),
    messages: [],
    createdAt: time,
    updatedAt: time,
    state: { sessionId: session.id },
  })
}

export async function clearPendingRun(
  store: SessionStore,
  session: StoredSession,
  runId: string,
): Promise<void> {
  const state = asAgentState(session.state)
  const { pendingRun: _pendingRun, ...rest } = state
  await store.set({ ...session, state: rest })
  await store.delete(ownerKey(runId))
}

export async function grantApproval(
  session: StoredSession,
  toolName: string,
  input: unknown,
): Promise<StoredSession> {
  const state = asAgentState(session.state)
  const grants = structuredClone(state.approvalGrants ?? {})
  const hashes = new Set(grants[toolName] ?? [])
  hashes.add(await argumentHash(input))
  grants[toolName] = [...hashes]
  return { ...session, state: { ...state, approvalGrants: grants } }
}

export async function hasApprovalGrant(
  session: StoredSession | null,
  toolName: string,
  input: unknown,
): Promise<boolean> {
  const hashes = asAgentState(session?.state).approvalGrants?.[toolName]
  return hashes?.includes(await argumentHash(input)) ?? false
}

function asAgentState(state: Record<string, unknown> | undefined): AgentSessionState {
  return (state ?? {}) as AgentSessionState
}

function ownerKey(runId: string): string {
  return `sitebot-run:${runId}`
}
