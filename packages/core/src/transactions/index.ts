import type {
  ChangePlan,
  ChangeRequest,
  Evidence,
  ExecutionId,
  JsonValue,
  PlanDigest,
  RequestFingerprint,
  RollbackVerification,
  TargetAdapter,
  TargetObservation,
} from '@deepsync/contracts'
import { AdapterRegistry } from '../adapters/index.ts'
import { DeepSyncError, errorMessage } from '../errors/index.ts'
import { planDigest, requestFingerprint } from '../resolver/index.ts'
import {
  MemoryStateStore,
  SerialRunLock,
  quarantineKey,
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

function asChangePlan(plan: JsonValue): ChangePlan {
  return plan as unknown as ChangePlan
}

function fingerprintInput(request: ChangeRequest): JsonValue {
  return { targetInstanceId: request.targetInstanceId, intent: request.intent }
}

function executionId(): ExecutionId {
  return `execution-${crypto.randomUUID()}` as ExecutionId
}

function terminalResult(record: TransactionRecord, replayed: boolean): ExecutionResult | undefined {
  if (record.phase === 'committed' && record.observation !== undefined) return { status: 'committed', planDigest: record.planDigest, observation: record.observation, replayed }
  if (record.phase === 'rejected') return { status: 'rejected', planDigest: record.planDigest, reason: record.failure?.message ?? 'rejected', replayed }
  if (record.phase === 'quarantined') return { status: 'quarantined', planDigest: record.planDigest, reason: record.failure?.message ?? 'quarantined', restored: record.restored === true, replayed }
  return undefined
}

function removeKey<Value>(source: Readonly<Record<string, Value>>, key: string): Record<string, Value> {
  const next = { ...source }
  delete next[key]
  return next
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
    if (plan.adapterId !== adapter.id) throw new DeepSyncError('PLAN_INVALID', 'Adapter returned a plan for a different adapter')
    if (plan.targetInstanceId !== request.targetInstanceId) throw new DeepSyncError('TARGET_MISMATCH', 'Adapter plan targets a different instance')
    return { request, requestFingerprint: requestFingerprint(fingerprintInput(request)), plan, planDigest: planDigest(asJsonPlan(plan)) }
  }

  async execute(request: ChangeRequest, supplied?: PlannedChange): Promise<ExecutionResult> {
    return await this.#lock.withExclusive(async () => {
      let state = await this.#state.load()
      const fingerprint = requestFingerprint(fingerprintInput(request))
      const existing = state.transactions[request.requestId]
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) throw new DeepSyncError('IDEMPOTENCY_CONFLICT', `Request id ${request.requestId} was reused with different intent or target`)
        const terminal = terminalResult(existing, true)
        if (terminal !== undefined) return terminal
        throw new DeepSyncError('TRANSACTION_IN_PROGRESS', `Request ${request.requestId} is not terminal`)
      }
      const uncertain = Object.values(state.transactions).find(record => record.targetInstanceId === request.targetInstanceId && terminalResult(record, true) === undefined)
      if (uncertain !== undefined) throw new DeepSyncError('TRANSACTION_IN_PROGRESS', `Target ${request.targetInstanceId} has uncertain transaction ${uncertain.requestId}`)

      const planned = supplied ?? await this.plan(request)
      if (planned.request.requestId !== request.requestId || planned.request.targetInstanceId !== request.targetInstanceId || planned.requestFingerprint !== fingerprint) {
        throw new DeepSyncError('IDEMPOTENCY_CONFLICT', 'Supplied plan belongs to a different request, target, or intent')
      }
      const requestedAdapter = this.#adapterForRequest(request)
      if (planned.plan.adapterId !== requestedAdapter.id) throw new DeepSyncError('PLAN_INVALID', 'Supplied plan uses a different adapter')
      if (planned.plan.targetInstanceId !== request.targetInstanceId) throw new DeepSyncError('TARGET_MISMATCH', 'Supplied plan targets a different instance')
      const computedPlanDigest = planDigest(asJsonPlan(planned.plan))
      if (planned.planDigest !== computedPlanDigest) throw new DeepSyncError('PLAN_INVALID', 'Supplied plan digest does not match its content')
      const quarantine = state.quarantined[quarantineKey(request.targetInstanceId, planned.plan.artifactDigest)]
      if (quarantine !== undefined) throw new DeepSyncError('PLAN_QUARANTINED', `Artifact ${planned.plan.artifactDigest} is quarantined for target ${request.targetInstanceId}: ${quarantine.reason}`)

      const adapter = requestedAdapter
      let record: TransactionRecord = {
        requestId: request.requestId,
        requestFingerprint: fingerprint,
        phase: 'planned',
        adapterId: adapter.id,
        targetInstanceId: request.targetInstanceId,
        artifactDigest: planned.plan.artifactDigest,
        planDigest: planned.planDigest,
        plan: asJsonPlan(planned.plan),
        ...(state.targetHeads[request.targetInstanceId] === undefined ? {} : { previousTargetHead: state.targetHeads[request.targetInstanceId] }),
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
        const committedSnapshot = await adapter.snapshot(planned.plan)
        record = { ...record, phase: 'committed' }
        const next: StoredState = {
          ...state,
          revision: state.revision + 1,
          transactions: { ...state.transactions, [record.requestId]: record },
          lastKnownGood: { ...state.lastKnownGood, [record.targetInstanceId]: committedSnapshot },
          targetHeads: { ...state.targetHeads, [record.targetInstanceId]: record.requestId },
        }
        await this.#state.save(state.revision, next)
        return { status: 'committed', planDigest: record.planDigest, observation, replayed: false }
      } catch (error) {
        if (!mutationMayHaveStarted) {
          const failure = this.#failure(error, record.phase)
          ;({ record } = await this.#transition(state, record, 'rejected', { failure }))
          return { status: 'rejected', planDigest: record.planDigest, reason: failure.message, replayed: false }
        }
        state = await this.#state.load()
        record = state.transactions[record.requestId] ?? record
        return await this.#rollback(state, record, adapter, error)
      }
    })
  }

  async rollback(requestId: string): Promise<ExecutionResult> {
    return await this.#lock.withExclusive(async () => {
      const state = await this.#state.load()
      const record = state.transactions[requestId]
      if (record === undefined) throw new DeepSyncError('PLAN_INVALID', `Transaction ${requestId} does not exist`)
      if (record.phase === 'quarantined') return terminalResult(record, true)!
      if (record.phase !== 'committed') throw new DeepSyncError('TRANSACTION_IN_PROGRESS', `Transaction ${requestId} is not committed`)
      if (state.targetHeads[record.targetInstanceId] !== record.requestId) throw new DeepSyncError('TARGET_HEAD_MISMATCH', `Transaction ${requestId} is not the current head for target ${record.targetInstanceId}`)
      if (record.snapshot === undefined || record.executionId === undefined) throw new DeepSyncError('STATE_CORRUPT', `Transaction ${requestId} has no rollback snapshot`)
      return await this.#rollback(state, record, this.#adapter(record.adapterId), new Error('Operator requested rollback'), true)
    })
  }

  async recover(): Promise<readonly TransactionRecord[]> {
    return await this.#lock.withExclusive(async () => {
      let state = await this.#state.load()
      const recovered: TransactionRecord[] = []
      const latestCommitted: Record<string, string> = {}
      for (const record of Object.values(state.transactions)) if (record.phase === 'committed') latestCommitted[record.targetInstanceId] = record.requestId

      for (const candidate of Object.values(state.transactions)) {
        const terminal = terminalResult(candidate, true)
        if (terminal !== undefined) {
          if (candidate.phase === 'committed' && latestCommitted[candidate.targetInstanceId] === candidate.requestId
            && (state.lastKnownGood[candidate.targetInstanceId] === undefined || state.targetHeads[candidate.targetInstanceId] === undefined)) {
            const adapter = this.#adapter(candidate.adapterId)
            const committedSnapshot = await adapter.snapshot(asChangePlan(candidate.plan))
            const next: StoredState = {
              ...state,
              revision: state.revision + 1,
              lastKnownGood: { ...state.lastKnownGood, [candidate.targetInstanceId]: committedSnapshot },
              targetHeads: { ...state.targetHeads, [candidate.targetInstanceId]: candidate.requestId },
            }
            await this.#state.save(state.revision, next)
            state = next
            recovered.push(candidate)
          } else if (candidate.phase === 'quarantined') {
            const key = quarantineKey(candidate.targetInstanceId, candidate.artifactDigest)
            if (state.quarantined[key] === undefined) {
              const next: StoredState = {
                ...state,
                revision: state.revision + 1,
                quarantined: { ...state.quarantined, [key]: { artifactDigest: candidate.artifactDigest, targetInstanceId: candidate.targetInstanceId, planDigest: candidate.planDigest, requestId: candidate.requestId, reason: candidate.failure?.message ?? 'quarantined', restored: candidate.restored === true } },
              }
              await this.#state.save(state.revision, next)
              state = next
              recovered.push(candidate)
            }
          }
          continue
        }

        let record = candidate
        const adapter = this.#adapter(record.adapterId)
        if (['planned', 'validated', 'snapshotted'].includes(record.phase)) {
          const failure = this.#failure(new Error('Interrupted before target mutation'), record.phase)
          ;({ state, record } = await this.#transition(state, record, 'rejected', { failure }))
        } else if (record.phase === 'verifying-rollback') {
          await this.#verifyAndQuarantine(state, record, adapter, record.failure ?? this.#failure(new Error('Recovered rollback verification'), record.phase))
          state = await this.#state.load()
          record = state.transactions[record.requestId] ?? record
        } else if (record.phase === 'rolling-back') {
          let verification: RollbackVerification | undefined
          try {
            if (record.snapshot !== undefined) verification = await adapter.verifyRollback(record.snapshot)
          } catch {
            verification = undefined
          }
          if (verification?.restored === true) await this.#verifyAndQuarantine(state, record, adapter, record.failure ?? this.#failure(new Error('Recovered completed rollback'), record.phase), undefined, verification)
          else await this.#rollback(state, record, adapter, new Error(`Recovered uncertain transaction from ${record.phase}`))
          state = await this.#state.load()
          record = state.transactions[record.requestId] ?? record
        } else {
          await this.#rollback(state, record, adapter, new Error(`Recovered uncertain transaction from ${record.phase}`))
          state = await this.#state.load()
          record = state.transactions[record.requestId] ?? record
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
    const adapterId = typeof request.intent === 'object' && request.intent !== null && !Array.isArray(request.intent) ? (request.intent as Readonly<Record<string, JsonValue>>).adapterId : undefined
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

  async #rollback(state: StoredState, record: TransactionRecord, adapter: TargetAdapter, cause: unknown, operatorRequested = record.rollbackKind === 'operator'): Promise<ExecutionResult> {
    const failure = this.#failure(cause, record.phase)
    ;({ state, record } = await this.#transition(state, record, 'rolling-back', { failure, rollbackKind: operatorRequested ? 'operator' : 'failure' }))
    let rollbackError: string | undefined
    if (record.snapshot !== undefined && record.executionId !== undefined) {
      try {
        await adapter.rollback(record.snapshot, record.executionId)
      } catch (error) {
        rollbackError = errorMessage(error)
      }
    } else rollbackError = 'Transaction has no durable snapshot or execution id'
    const failureWithRollback: FailureRecord = rollbackError === undefined ? failure : { ...failure, rollbackError }
    ;({ state, record } = await this.#transition(state, record, 'verifying-rollback', { failure: failureWithRollback }))
    return await this.#verifyAndQuarantine(state, record, adapter, failureWithRollback, rollbackError)
  }

  async #verifyAndQuarantine(state: StoredState, record: TransactionRecord, adapter: TargetAdapter, failure: FailureRecord, initialRollbackError?: string, suppliedVerification?: RollbackVerification): Promise<ExecutionResult> {
    let rollbackError = initialRollbackError
    let restored = false
    let evidence: readonly Evidence[] = []
    try {
      if (record.snapshot !== undefined) {
        const verification = suppliedVerification ?? await adapter.verifyRollback(record.snapshot)
        restored = verification.restored
        evidence = verification.evidence
      }
    } catch (error) {
      rollbackError = [rollbackError, errorMessage(error)].filter(Boolean).join('; ')
    }
    const finalFailure: FailureRecord = rollbackError === undefined ? failure : { ...failure, rollbackError }
    const finalRecord: TransactionRecord = { ...record, phase: 'quarantined', failure: finalFailure, restored, rollbackEvidence: evidence as unknown as JsonValue }
    let targetHeads = state.targetHeads
    if (state.targetHeads[record.targetInstanceId] === record.requestId) targetHeads = record.previousTargetHead === undefined ? removeKey(state.targetHeads, record.targetInstanceId) : { ...state.targetHeads, [record.targetInstanceId]: record.previousTargetHead }
    const key = quarantineKey(record.targetInstanceId, record.artifactDigest)
    const next: StoredState = {
      ...state,
      revision: state.revision + 1,
      transactions: { ...state.transactions, [record.requestId]: finalRecord },
      quarantined: { ...state.quarantined, [key]: { artifactDigest: record.artifactDigest, targetInstanceId: record.targetInstanceId, planDigest: record.planDigest, requestId: record.requestId, reason: finalFailure.message, restored } },
      lastKnownGood: restored && record.snapshot !== undefined && record.rollbackKind === 'operator' ? { ...state.lastKnownGood, [record.targetInstanceId]: record.snapshot } : state.lastKnownGood,
      targetHeads,
    }
    await this.#state.save(state.revision, next)
    return { status: 'quarantined', planDigest: record.planDigest, reason: finalFailure.message, restored, replayed: false }
  }
}
