import type {
  ChangePlan,
  ChangeRequest,
  Evidence,
  ExecutionId,
  JsonValue,
  PlanDigest,
  RequestFingerprint,
  TargetAdapter,
  TargetObservation,
} from '@deepsync/contracts'
import { AdapterRegistry } from '../adapters/index.ts'
import { DeepSyncError, errorMessage } from '../errors/index.ts'
import { planDigest, requestFingerprint } from '../resolver/index.ts'
import {
  MemoryStateStore,
  SerialRunLock,
  type FailureRecord,
  type RunLock,
  type StateStore,
  type StoredState,
  type TransactionPhase,
  type TransactionRecord,
} from '../state/index.ts'

export type ExecutionResult =
  | { readonly status: 'committed'; readonly planDigest: PlanDigest; readonly observation: TargetObservation; readonly replayed: boolean }
  | { readonly status: 'rejected'; readonly planDigest: PlanDigest; readonly reason: string; readonly replayed: boolean }
  | { readonly status: 'quarantined'; readonly planDigest: PlanDigest; readonly reason: string; readonly restored: boolean; readonly replayed: boolean }

export interface PlannedChange {
  readonly request: ChangeRequest
  readonly requestFingerprint: RequestFingerprint
  readonly plan: ChangePlan
  readonly planDigest: PlanDigest
}

function asJsonPlan(plan: ChangePlan): JsonValue {
  return plan as unknown as JsonValue
}

function executionId(): ExecutionId {
  return `execution-${crypto.randomUUID()}` as ExecutionId
}

function terminalResult(record: TransactionRecord, replayed: boolean): ExecutionResult | undefined {
  if (record.phase === 'committed' && record.observation !== undefined) {
    return { status: 'committed', planDigest: record.planDigest, observation: record.observation, replayed }
  }
  if (record.phase === 'rejected') {
    return { status: 'rejected', planDigest: record.planDigest, reason: record.failure?.message ?? 'rejected', replayed }
  }
  if (record.phase === 'quarantined') {
    return { status: 'quarantined', planDigest: record.planDigest, reason: record.failure?.message ?? 'quarantined', restored: record.restored === true, replayed }
  }
  return undefined
}

export class LifecycleManager {
  readonly #adapters: AdapterRegistry
  readonly #state: StateStore
  readonly #lock: RunLock

  constructor(options: { readonly adapters: readonly TargetAdapter[]; readonly state?: StateStore; readonly lock?: RunLock }) {
    this.#adapters = new AdapterRegistry(options.adapters)
    this.#state = options.state ?? new MemoryStateStore()
    this.#lock = options.lock ?? new SerialRunLock()
  }

  async plan(request: ChangeRequest): Promise<PlannedChange> {
    const adapter = this.#adapterForRequest(request)
    const plan = await adapter.plan(request)
    if (plan.targetInstanceId !== request.targetInstanceId) throw new Error('Adapter plan targets a different instance')
    return { request, requestFingerprint: requestFingerprint(request.intent), plan, planDigest: planDigest(asJsonPlan(plan)) }
  }

  async execute(request: ChangeRequest, supplied?: PlannedChange): Promise<ExecutionResult> {
    return await this.#lock.withExclusive(async () => {
      let state = await this.#state.load()
      const fingerprint = requestFingerprint(request.intent)
      const existing = state.transactions[request.requestId]
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) throw new DeepSyncError('IDEMPOTENCY_CONFLICT', `Request id ${request.requestId} was reused with different intent`)
        const terminal = terminalResult(existing, true)
        if (terminal !== undefined) return terminal
        throw new DeepSyncError('TRANSACTION_IN_PROGRESS', `Request ${request.requestId} is not terminal`)
      }

      const planned = supplied ?? await this.plan(request)
      if (planned.requestFingerprint !== fingerprint) throw new DeepSyncError('IDEMPOTENCY_CONFLICT', 'Supplied plan belongs to different intent')
      const quarantined = state.quarantined[planned.planDigest]
      if (quarantined !== undefined) throw new DeepSyncError('PLAN_QUARANTINED', `Plan ${planned.planDigest} is quarantined: ${quarantined.reason}`)
      const adapter = this.#adapter(planned.plan.adapterId)
      let record: TransactionRecord = {
        requestId: request.requestId,
        requestFingerprint: fingerprint,
        phase: 'planned',
        adapterId: adapter.id,
        targetInstanceId: request.targetInstanceId,
        planDigest: planned.planDigest,
        plan: asJsonPlan(planned.plan),
      }
      ;({ state, record } = await this.#put(state, record))
      let mutationMayHaveStarted = false
      try {
        const evidence = await adapter.validate(planned.plan)
        ;({ state, record } = await this.#transition(state, record, 'validated', { rollbackEvidence: evidence as unknown as JsonValue }))
        const snapshot = await adapter.snapshot(planned.plan)
        const id = executionId()
        ;({ state, record } = await this.#transition(state, record, 'snapshotted', { snapshot, executionId: id }))
        ;({ state, record } = await this.#transition(state, record, 'applying'))
        mutationMayHaveStarted = true
        await adapter.apply(planned.plan, id)
        ;({ state, record } = await this.#transition(state, record, 'applied'))
        const observation = await adapter.observe(planned.plan)
        ;({ state, record } = await this.#transition(state, record, 'observed', { observation }))
        const health = await adapter.health(planned.plan, observation)
        if (!health.ok) throw new DeepSyncError('HEALTH_FAILED', health.reason)
        ;({ state, record } = await this.#transition(state, record, 'healthy', { rollbackEvidence: health.evidence as unknown as JsonValue }))
        ;({ state, record } = await this.#transition(state, record, 'committed'))
        const next: StoredState = {
          ...state,
          revision: state.revision + 1,
          lastKnownGood: { ...state.lastKnownGood, [record.targetInstanceId]: record.snapshot! },
        }
        await this.#state.save(state.revision, next)
        return { status: 'committed', planDigest: record.planDigest, observation, replayed: false }
      } catch (error) {
        if (!mutationMayHaveStarted) {
          const failure = this.#failure(error, record.phase)
          ;({ record } = await this.#transition(state, record, 'rejected', { failure }))
          return { status: 'rejected', planDigest: record.planDigest, reason: failure.message, replayed: false }
        }
        return await this.#rollback(state, record, adapter, error)
      }
    })
  }

  async recover(): Promise<readonly TransactionRecord[]> {
    return await this.#lock.withExclusive(async () => {
      let state = await this.#state.load()
      const recovered: TransactionRecord[] = []
      for (const candidate of Object.values(state.transactions)) {
        if (terminalResult(candidate, true) !== undefined) continue
        let record = candidate
        const adapter = this.#adapter(record.adapterId)
        if (['planned', 'validated', 'snapshotted'].includes(record.phase)) {
          const failure = this.#failure(new Error('Interrupted before target mutation'), record.phase)
          ;({ state, record } = await this.#transition(state, record, 'rejected', { failure }))
        } else {
          const result = await this.#rollback(state, record, adapter, new Error(`Recovered uncertain transaction from ${record.phase}`))
          state = await this.#state.load()
          record = state.transactions[record.requestId] ?? record
          if (result.status !== 'quarantined') throw new Error('Recovery did not quarantine uncertain transaction')
        }
        recovered.push(record)
      }
      return recovered
    })
  }

  async state(): Promise<StoredState> {
    return await this.#state.load()
  }

  #adapterForRequest(request: ChangeRequest): TargetAdapter {
    const adapterId = typeof request.intent === 'object' && request.intent !== null && !Array.isArray(request.intent)
      ? (request.intent as Readonly<Record<string, JsonValue>>).adapterId
      : undefined
    if (typeof adapterId !== 'string') throw new DeepSyncError('ADAPTER_NOT_FOUND', 'Change intent must name adapterId')
    return this.#adapter(adapterId)
  }

  #adapter(id: string): TargetAdapter {
    const adapter = this.#adapters.get(id)
    if (adapter === undefined) throw new DeepSyncError('ADAPTER_NOT_FOUND', `Adapter ${id} is not registered`)
    return adapter
  }

  #failure(error: unknown, phase: TransactionPhase): FailureRecord {
    return { code: error instanceof DeepSyncError ? error.code : 'UNEXPECTED', message: errorMessage(error), phase }
  }

  async #put(state: StoredState, record: TransactionRecord): Promise<{ state: StoredState; record: TransactionRecord }> {
    const next: StoredState = { ...state, revision: state.revision + 1, transactions: { ...state.transactions, [record.requestId]: record } }
    await this.#state.save(state.revision, next)
    return { state: next, record }
  }

  async #transition(state: StoredState, record: TransactionRecord, phase: TransactionPhase, patch: Partial<TransactionRecord> = {}): Promise<{ state: StoredState; record: TransactionRecord }> {
    return await this.#put(state, { ...record, ...patch, phase })
  }

  async #rollback(state: StoredState, record: TransactionRecord, adapter: TargetAdapter, cause: unknown): Promise<ExecutionResult> {
    const failure = this.#failure(cause, record.phase)
    ;({ state, record } = await this.#transition(state, record, 'rolling-back', { failure }))
    let rollbackError: string | undefined
    if (record.snapshot !== undefined && record.executionId !== undefined) {
      try {
        await adapter.rollback(record.snapshot, record.executionId)
      } catch (error) {
        rollbackError = errorMessage(error)
      }
    } else {
      rollbackError = 'Transaction has no durable snapshot or execution id'
    }
    const failureWithRollback: FailureRecord = rollbackError === undefined ? failure : { ...failure, rollbackError }
    ;({ state, record } = await this.#transition(state, record, 'verifying-rollback', { failure: failureWithRollback }))
    let restored = false
    let evidence: readonly Evidence[] = []
    try {
      if (record.snapshot !== undefined) {
        const verification = await adapter.verifyRollback(record.snapshot)
        restored = verification.restored
        evidence = verification.evidence
      }
    } catch (error) {
      rollbackError = [rollbackError, errorMessage(error)].filter(Boolean).join('; ')
    }
    const finalFailure: FailureRecord = rollbackError === undefined ? failureWithRollback : { ...failureWithRollback, rollbackError }
    ;({ state, record } = await this.#transition(state, record, 'quarantined', {
      failure: finalFailure,
      restored,
      rollbackEvidence: evidence as unknown as JsonValue,
    }))
    const next: StoredState = {
      ...state,
      revision: state.revision + 1,
      quarantined: {
        ...state.quarantined,
        [record.planDigest]: { planDigest: record.planDigest, requestId: record.requestId, reason: finalFailure.message, restored },
      },
    }
    await this.#state.save(state.revision, next)
    return { status: 'quarantined', planDigest: record.planDigest, reason: finalFailure.message, restored, replayed: false }
  }
}
