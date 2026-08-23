import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
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
  readonly planDigest: PlanDigest
  readonly plan: JsonValue
  readonly executionId?: ExecutionId
  readonly snapshot?: TargetSnapshot
  readonly observation?: TargetObservation
  readonly failure?: FailureRecord
  readonly restored?: boolean
  readonly rollbackEvidence?: JsonValue
}

export interface QuarantineRecord {
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
}

export interface StateStore {
  load(): Promise<StoredState>
  save(expectedRevision: number, next: StoredState): Promise<void>
}

export interface RunLock {
  withExclusive<Value>(run: () => Promise<Value>): Promise<Value>
}

export function emptyState(): StoredState {
  return { schemaVersion: 1, revision: 0, transactions: {}, quarantined: {}, lastKnownGood: {} }
}

function validateState(value: unknown): StoredState {
  if (value === null || typeof value !== 'object') throw new DeepSyncError('STATE_CORRUPT', 'DeepSync state must be an object')
  const candidate = value as Partial<StoredState>
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.revision) || candidate.transactions === undefined
    || candidate.quarantined === undefined || candidate.lastKnownGood === undefined) {
    throw new DeepSyncError('STATE_CORRUPT', 'DeepSync state is malformed or has an unsupported version')
  }
  return candidate as StoredState
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
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.filename)
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
