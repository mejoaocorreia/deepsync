import { mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ArtifactDigest,
  ExecutionId,
  JsonValue,
  PlanDigest,
  RequestFingerprint,
  RequestId,
  TargetObservation,
  TargetSnapshot,
} from '@deepsync/contracts'
import { DeepSyncError } from '../errors/index.ts'

export type TransactionPhase =
  | 'planned'
  | 'validated'
  | 'snapshotted'
  | 'applying'
  | 'applied'
  | 'observed'
  | 'healthy'
  | 'rolling-back'
  | 'verifying-rollback'
  | 'committed'
  | 'rejected'
  | 'quarantined'

const PHASES = new Set<TransactionPhase>([
  'planned', 'validated', 'snapshotted', 'applying', 'applied', 'observed', 'healthy',
  'rolling-back', 'verifying-rollback', 'committed', 'rejected', 'quarantined',
])

export interface FailureRecord {
  readonly code: string
  readonly message: string
  readonly phase: TransactionPhase
  readonly rollbackError?: string
}

export interface TransactionRecord {
  readonly requestId: RequestId
  readonly requestFingerprint: RequestFingerprint
  readonly phase: TransactionPhase
  readonly adapterId: string
  readonly targetInstanceId: string
  readonly artifactDigest: ArtifactDigest
  readonly planDigest: PlanDigest
  readonly plan: JsonValue
  readonly previousTargetHead?: RequestId
  readonly executionId?: ExecutionId
  readonly snapshot?: TargetSnapshot
  readonly observation?: TargetObservation
  readonly failure?: FailureRecord
  readonly restored?: boolean
  readonly rollbackEvidence?: JsonValue
}

export interface QuarantineRecord {
  readonly artifactDigest: ArtifactDigest
  readonly targetInstanceId: string
  readonly planDigest: PlanDigest
  readonly requestId: RequestId
  readonly reason: string
  readonly restored: boolean
}

export interface StoredState {
  readonly schemaVersion: 1
  readonly revision: number
  readonly transactions: Readonly<Record<string, TransactionRecord>>
  readonly quarantined: Readonly<Record<string, QuarantineRecord>>
  readonly lastKnownGood: Readonly<Record<string, TargetSnapshot>>
  readonly targetHeads: Readonly<Record<string, RequestId>>
}

export interface StateStore {
  load(): Promise<StoredState>
  save(expectedRevision: number, next: StoredState): Promise<void>
}

export interface RunLock {
  withExclusive<Value>(run: () => Promise<Value>): Promise<Value>
}

export function quarantineKey(targetInstanceId: string, artifactDigest: ArtifactDigest): string {
  return `${targetInstanceId}:${artifactDigest}`
}

export function emptyState(): StoredState {
  return { schemaVersion: 1, revision: 0, transactions: {}, quarantined: {}, lastKnownGood: {}, targetHeads: {} }
}

function objectMap(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeepSyncError('STATE_CORRUPT', `${subject} must be an object map`)
  return value as Record<string, unknown>
}

function normalizeTransaction(key: string, value: unknown): TransactionRecord {
  const record = objectMap(value, `Transaction ${key}`)
  const plan = objectMap(record.plan, `Transaction ${key} plan`)
  const artifactDigest = record.artifactDigest ?? plan.artifactDigest
  if (record.requestId !== key || typeof record.requestFingerprint !== 'string' || typeof record.phase !== 'string'
    || !PHASES.has(record.phase as TransactionPhase) || typeof record.adapterId !== 'string'
    || typeof record.targetInstanceId !== 'string' || typeof artifactDigest !== 'string'
    || typeof record.planDigest !== 'string') {
    throw new DeepSyncError('STATE_CORRUPT', `Transaction ${key} is malformed`)
  }
  return { ...record, artifactDigest } as unknown as TransactionRecord
}

function validateState(value: unknown): StoredState {
  const candidate = objectMap(value, 'DeepSync state')
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.revision)) {
    throw new DeepSyncError('STATE_CORRUPT', 'DeepSync state has an unsupported or malformed version')
  }
  const transactionValues = objectMap(candidate.transactions, 'DeepSync transactions')
  const transactions = Object.fromEntries(Object.entries(transactionValues).map(([key, record]) => [key, normalizeTransaction(key, record)]))
  const quarantineValues = objectMap(candidate.quarantined, 'DeepSync quarantine')
  const quarantined: Record<string, QuarantineRecord> = {}
  for (const value of Object.values(quarantineValues)) {
    const record = objectMap(value, 'Quarantine record')
    const transaction = typeof record.requestId === 'string' ? transactions[record.requestId] : undefined
    const artifactDigest = record.artifactDigest ?? transaction?.artifactDigest
    const targetInstanceId = record.targetInstanceId ?? transaction?.targetInstanceId
    if (typeof artifactDigest !== 'string' || typeof targetInstanceId !== 'string' || typeof record.planDigest !== 'string'
      || typeof record.requestId !== 'string' || typeof record.reason !== 'string' || typeof record.restored !== 'boolean') {
      throw new DeepSyncError('STATE_CORRUPT', 'Quarantine record is malformed')
    }
    const normalized = { ...record, artifactDigest, targetInstanceId } as unknown as QuarantineRecord
    quarantined[quarantineKey(targetInstanceId, artifactDigest as ArtifactDigest)] = normalized
  }
  const lastKnownGood = objectMap(candidate.lastKnownGood, 'DeepSync last-known-good') as Readonly<Record<string, TargetSnapshot>>
  const targetHeads = candidate.targetHeads === undefined
    ? {}
    : objectMap(candidate.targetHeads, 'DeepSync target heads') as Readonly<Record<string, RequestId>>
  if (Object.values(targetHeads).some(head => typeof head !== 'string')) throw new DeepSyncError('STATE_CORRUPT', 'DeepSync target heads are malformed')
  return { schemaVersion: 1, revision: candidate.revision as number, transactions, quarantined, lastKnownGood, targetHeads }
}

export class MemoryStateStore implements StateStore {
  #state: StoredState

  constructor(initial: StoredState = emptyState()) {
    this.#state = structuredClone(initial)
  }

  async load(): Promise<StoredState> {
    return structuredClone(this.#state)
  }

  async save(expectedRevision: number, next: StoredState): Promise<void> {
    if (this.#state.revision !== expectedRevision) throw new DeepSyncError('STATE_CONFLICT', 'DeepSync state revision changed')
    this.#state = structuredClone(next)
  }
}

async function syncParentDirectory(filename: string): Promise<void> {
  let handle
  try {
    handle = await open(dirname(filename), 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EISDIR' && code !== 'EINVAL')) throw error
  } finally {
    await handle?.close()
  }
}

export class JsonFileStateStore implements StateStore {
  constructor(readonly filename: string) {}

  async load(): Promise<StoredState> {
    try {
      return validateState(JSON.parse(await readFile(this.filename, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      if (error instanceof DeepSyncError) throw error
      throw new DeepSyncError('STATE_CORRUPT', `Cannot read DeepSync state ${this.filename}`, { cause: error })
    }
  }

  async save(expectedRevision: number, next: StoredState): Promise<void> {
    const current = await this.load()
    if (current.revision !== expectedRevision) throw new DeepSyncError('STATE_CONFLICT', 'DeepSync state revision changed')
    await mkdir(dirname(this.filename), { recursive: true })
    const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.filename)
      await syncParentDirectory(this.filename)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

export class SerialRunLock implements RunLock {
  #tail: Promise<void> = Promise.resolve()

  async withExclusive<Value>(run: () => Promise<Value>): Promise<Value> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }
}

interface LockMetadata {
  readonly schemaVersion: 1
  readonly pid: number
  readonly nonce: string
  readonly acquiredAt: string
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class FileRunLock implements RunLock {
  constructor(readonly filename: string, readonly timeoutMs = 30_000, readonly orphanGraceMs = 5_000) {}

  async withExclusive<Value>(run: () => Promise<Value>): Promise<Value> {
    await mkdir(dirname(this.filename), { recursive: true })
    const nonce = crypto.randomUUID()
    const deadline = Date.now() + this.timeoutMs
    while (true) {
      try {
        const handle = await open(this.filename, 'wx', 0o600)
        const metadata: LockMetadata = { schemaVersion: 1, pid: process.pid, nonce, acquiredAt: new Date().toISOString() }
        try {
          await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (await this.#reclaimOrphan()) continue
        if (Date.now() >= deadline) throw new DeepSyncError('LOCK_TIMEOUT', `Timed out waiting for DeepSync lock ${this.filename}`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    let result: Value
    try {
      result = await run()
    } catch (runError) {
      try {
        await this.#release(nonce)
      } catch (releaseError) {
        throw new AggregateError([runError, releaseError], 'DeepSync run and lock release both failed')
      }
      throw runError
    }
    await this.#release(nonce)
    return result
  }

  async #release(nonce: string): Promise<void> {
    try {
      const current = JSON.parse(await readFile(this.filename, 'utf8')) as LockMetadata
      if (current.nonce === nonce) await unlink(this.filename)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async #reclaimOrphan(): Promise<boolean> {
    try {
      const before = await readFile(this.filename, 'utf8')
      let metadata: LockMetadata | undefined
      try {
        metadata = JSON.parse(before) as LockMetadata
      } catch {
        if (Date.now() - (await stat(this.filename)).mtimeMs < this.orphanGraceMs) return false
      }
      if (metadata !== undefined && processIsAlive(metadata.pid)) return false
      if (await readFile(this.filename, 'utf8') !== before) return false
      await unlink(this.filename)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }
}
