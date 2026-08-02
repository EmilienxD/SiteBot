export type ApprovalDecision = 'approve' | 'deny'

export interface ApprovalCheckpoint {
  approvalId: string
  runId: string
  sessionId: string
  toolName: string
  input: unknown
  argumentHash: string
  risk: 'low' | 'medium' | 'high'
  createdAt: number
  expiresAt: number
  used: boolean
}

export interface ApprovalResolution {
  decision: ApprovalDecision
  sessionId: string
  runId: string
  approvalId: string
}

export class ApprovalError extends Error {
  readonly status: 403 | 410
  constructor(message: string, status: 403 | 410) {
    super(message)
    this.name = 'ApprovalError'
    this.status = status
  }
}

export class MemoryApprovalStore {
  private readonly checkpoints = new Map<string, ApprovalCheckpoint>()
  private readonly granted = new Map<string, Set<string>>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) { this.now = now }

  async create(input: Omit<ApprovalCheckpoint, 'argumentHash' | 'createdAt' | 'expiresAt' | 'used'> & { ttlMs: number }): Promise<ApprovalCheckpoint> {
    const checkpoint: ApprovalCheckpoint = {
      approvalId: input.approvalId,
      runId: input.runId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      input: input.input,
      risk: input.risk,
      argumentHash: await argumentHash(input.input),
      createdAt: this.now(),
      expiresAt: this.now() + input.ttlMs,
      used: false,
    }
    this.checkpoints.set(checkpointKey(checkpoint.sessionId, checkpoint.runId, checkpoint.approvalId), checkpoint)
    return structuredClone(checkpoint)
  }

  get(sessionId: string, runId: string, approvalId: string): ApprovalCheckpoint | null {
    const checkpoint = this.checkpoints.get(checkpointKey(sessionId, runId, approvalId))
    return checkpoint === undefined ? null : structuredClone(checkpoint)
  }

  async resolve(resolution: ApprovalResolution, policy: 'always' | 'once-per-session' | 'never'): Promise<ApprovalCheckpoint> {
    const checkpoint = this.checkpoints.get(checkpointKey(resolution.sessionId, resolution.runId, resolution.approvalId))
    if (checkpoint === undefined) throw new ApprovalError('Approval does not belong to this session.', 403)
    if (checkpoint.used) throw new ApprovalError('Approval has already been used.', 403)
    if (this.now() > checkpoint.expiresAt) throw new ApprovalError('Approval request expired.', 410)
    checkpoint.used = true
    if (resolution.decision === 'approve' && policy === 'once-per-session') {
      const key = `${resolution.sessionId}:${checkpoint.toolName}`
      const hashes = this.granted.get(key) ?? new Set<string>()
      hashes.add(checkpoint.argumentHash)
      this.granted.set(key, hashes)
    }
    return structuredClone(checkpoint)
  }

  async isGranted(sessionId: string, toolName: string, input: unknown): Promise<boolean> {
    const hashes = this.granted.get(`${sessionId}:${toolName}`)
    return hashes?.has(await argumentHash(input)) ?? false
  }
}

export async function argumentHash(value: unknown): Promise<string> {
  const canonical = stableStringify(value)
  const cryptoRef = globalThis.crypto
  if (cryptoRef?.subtle !== undefined) {
    const digest = await cryptoRef.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  let hash = 2166136261
  for (let index = 0; index < canonical.length; index += 1) hash = Math.imul(hash ^ canonical.charCodeAt(index), 16777619)
  return `fnv1a-${(hash >>> 0).toString(16)}`
}

function checkpointKey(sessionId: string, runId: string, approvalId: string): string { return `${sessionId}:${runId}:${approvalId}` }
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
}
