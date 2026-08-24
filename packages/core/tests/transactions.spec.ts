import type {
  ArtifactDigest,
  ChangePlan,
  ChangeRequest,
  Evidence,
  ExecutionId,
  JsonValue,
  RequestId,
  TargetAdapter,
  TargetHealth,
  TargetInstanceId,
  TargetObservation,
  TargetSnapshot,
} from '@deepsync/contracts'
import { describe, expect, it } from 'vitest'
import {
  LifecycleManager,
  MemoryStateStore,
  emptyState,
  planDigest,
  requestFingerprint,
  type StateStore,
  type StoredState,
} from '../src/index.ts'

const TARGET = 'fake-instance' as TargetInstanceId
const OTHER_TARGET = 'other-instance' as TargetInstanceId
const ARTIFACT = `sha256:${'a'.repeat(64)}` as ArtifactDigest
const now = '2026-08-24T00:00:00.000Z'
const pass = (id: string): Evidence => ({ checkId: id, status: 'pass', summary: id, observedAt: now })

function request(id: string, value = 'next', targetInstanceId = TARGET): ChangeRequest {
  return { requestId: id as RequestId, targetInstanceId, intent: { adapterId: 'fake', value } }
}

class RecordingStateStore implements StateStore {
  readonly delegate = new MemoryStateStore()
  readonly saves: StoredState[] = []

  async load(): Promise<StoredState> {
    return await this.delegate.load()
  }

  async save(expectedRevision: number, next: StoredState): Promise<void> {
    this.saves.push(structuredClone(next))
    await this.delegate.save(expectedRevision, next)
  }
}

class FakeAdapter implements TargetAdapter {
  readonly id = 'fake'
  value = 'initial'
  calls: string[] = []
  failAt?: string
  unhealthy = false

  async plan(input: ChangeRequest): Promise<ChangePlan> {
    this.calls.push('plan')
    const intent = input.intent as Readonly<Record<string, JsonValue>>
    return { schemaVersion: 1, adapterId: this.id, targetInstanceId: input.targetInstanceId, artifactDigest: ARTIFACT, operations: [{ set: intent.value ?? null }], metadata: {} }
  }

  async validate(): Promise<readonly Evidence[]> {
    this.calls.push('validate')
    if (this.failAt === 'validate') throw new Error('validate failed')
    return [pass('validate')]
  }

  async snapshot(): Promise<TargetSnapshot> {
    this.calls.push('snapshot')
    if (this.failAt === 'snapshot') throw new Error('snapshot failed')
    return { ref: { value: this.value } }
  }

  async apply(plan: ChangePlan, _executionId: ExecutionId): Promise<void> {
    this.calls.push('apply')
    const operation = plan.operations[0] as Readonly<Record<string, JsonValue>>
    this.value = String(operation.set)
    if (this.failAt === 'apply') throw new Error('apply failed after mutation')
  }

  async observe(): Promise<TargetObservation> {
    this.calls.push('observe')
    if (this.failAt === 'observe') throw new Error('observe failed')
    return { value: { value: this.value } }
  }

  async health(): Promise<TargetHealth> {
    this.calls.push('health')
    return this.unhealthy
      ? { ok: false, reason: 'fixture unhealthy', evidence: [{ ...pass('health'), status: 'fail' }] }
      : { ok: true, evidence: [pass('health')] }
  }

  async rollback(snapshot: TargetSnapshot): Promise<void> {
    this.calls.push('rollback')
    if (this.failAt === 'rollback') throw new Error('rollback failed')
    this.value = String((snapshot.ref as Readonly<Record<string, JsonValue>>).value)
  }

  async verifyRollback(snapshot: TargetSnapshot) {
    this.calls.push('verifyRollback')
    const expected = String((snapshot.ref as Readonly<Record<string, JsonValue>>).value)
    return this.value === expected
      ? { restored: true as const, evidence: [pass('rollback')] }
      : { restored: false as const, reason: 'value differs', evidence: [{ ...pass('rollback'), status: 'fail' as const }] }
  }
}

describe('LifecycleManager', () => {
  it('commits in lifecycle order, records committed LKG, and replays without adapter calls', async () => {
    const adapter = new FakeAdapter()
    const manager = new LifecycleManager({ adapters: [adapter] })
    const first = await manager.execute(request('one'))
    expect(first).toMatchObject({ status: 'committed', replayed: false })
    expect(adapter.calls).toEqual(['plan', 'validate', 'snapshot', 'apply', 'observe', 'health', 'snapshot'])
    const state = await manager.state()
    expect(state.lastKnownGood[TARGET]).toEqual({ ref: { value: 'next' } })
    expect(state.targetHeads[TARGET]).toBe('one')
    const count = adapter.calls.length
    expect(await manager.execute(request('one'))).toMatchObject({ status: 'committed', replayed: true })
    expect(adapter.calls).toHaveLength(count)
  })

  it('publishes terminal records and their indexes atomically', async () => {
    const committedStore = new RecordingStateStore()
    const committedAdapter = new FakeAdapter()
    await new LifecycleManager({ adapters: [committedAdapter], state: committedStore }).execute(request('atomic-commit'))
    const committed = committedStore.saves.find(state => state.transactions['atomic-commit']?.phase === 'committed')!
    expect(committed.lastKnownGood[TARGET]).toBeDefined()
    expect(committed.targetHeads[TARGET]).toBe('atomic-commit')

    const failedStore = new RecordingStateStore()
    const failedAdapter = new FakeAdapter()
    failedAdapter.unhealthy = true
    await new LifecycleManager({ adapters: [failedAdapter], state: failedStore }).execute(request('atomic-quarantine'))
    const quarantined = failedStore.saves.find(state => state.transactions['atomic-quarantine']?.phase === 'quarantined')!
    expect(Object.values(quarantined.quarantined)).toHaveLength(1)
  })

  it('rolls back only the current committed target head', async () => {
    const adapter = new FakeAdapter()
    const manager = new LifecycleManager({ adapters: [adapter] })
    await manager.execute(request('head-one', 'one'))
    await manager.execute(request('head-two', 'two'))
    await expect(manager.rollback('head-one')).rejects.toMatchObject({ code: 'TARGET_HEAD_MISMATCH' })
    expect(adapter.value).toBe('two')
    expect(await manager.rollback('head-two')).toMatchObject({ status: 'quarantined', restored: true })
    expect(adapter.value).toBe('one')
    expect((await manager.state()).targetHeads[TARGET]).toBe('head-one')
  })

  it('rejects before mutation when validation fails', async () => {
    const adapter = new FakeAdapter()
    adapter.failAt = 'validate'
    const manager = new LifecycleManager({ adapters: [adapter] })
    const result = await manager.execute(request('validation'))
    expect(result).toMatchObject({ status: 'rejected', reason: 'validate failed' })
    expect(adapter.calls).toEqual(['plan', 'validate'])
    expect(adapter.value).toBe('initial')
  })

  it.each(['apply', 'observe'] as const)('rolls back, verifies, and quarantines a %s failure', async failAt => {
    const adapter = new FakeAdapter()
    adapter.failAt = failAt
    const manager = new LifecycleManager({ adapters: [adapter] })
    const result = await manager.execute(request(`failure-${failAt}`))
    expect(result).toMatchObject({ status: 'quarantined', restored: true })
    expect(adapter.value).toBe('initial')
    expect(adapter.calls.slice(-2)).toEqual(['rollback', 'verifyRollback'])
    expect(Object.keys((await manager.state()).quarantined)).toHaveLength(1)
  })

  it('quarantines artifact bytes across plan metadata changes', async () => {
    const adapter = new FakeAdapter()
    adapter.unhealthy = true
    const manager = new LifecycleManager({ adapters: [adapter] })
    expect(await manager.execute(request('unhealthy', 'one'))).toMatchObject({ status: 'quarantined', restored: true })
    await expect(manager.execute(request('changed-plan', 'two'))).rejects.toMatchObject({ code: 'PLAN_QUARANTINED' })
  })

  it('binds idempotency to target and rejects tampered supplied plans', async () => {
    const adapter = new FakeAdapter()
    const manager = new LifecycleManager({ adapters: [adapter] })
    await manager.execute(request('same-id'))
    await expect(manager.execute(request('same-id', 'next', OTHER_TARGET))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const planned = await manager.plan(request('tampered', 'safe'))
    const tampered = { ...planned, plan: { ...planned.plan, metadata: { injected: true } } }
    const count = adapter.calls.length
    await expect(manager.execute(request('tampered', 'safe'), tampered)).rejects.toMatchObject({ code: 'PLAN_INVALID' })
    expect(adapter.calls).toHaveLength(count)
  })

  it('recovers a durably uncertain applying transaction without replaying apply', async () => {
    const adapter = new FakeAdapter()
    const bootstrap = new LifecycleManager({ adapters: [adapter] })
    const input = request('recover-applying')
    const planned = await bootstrap.plan(input)
    const initial: StoredState = {
      ...emptyState(),
      revision: 1,
      transactions: {
        [input.requestId]: {
          requestId: input.requestId,
          requestFingerprint: planned.requestFingerprint,
          phase: 'applying',
          adapterId: adapter.id,
          targetInstanceId: input.targetInstanceId,
          artifactDigest: planned.plan.artifactDigest,
          planDigest: planned.planDigest,
          plan: planned.plan as unknown as JsonValue,
          executionId: 'execution-recovery' as ExecutionId,
          snapshot: { ref: { value: 'initial' } },
        },
      },
    }
    adapter.value = 'mutated'
    adapter.calls = []
    const manager = new LifecycleManager({ adapters: [adapter], state: new MemoryStateStore(initial) })
    const recovered = await manager.recover()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ phase: 'quarantined', restored: true })
    expect(adapter.calls).toEqual(['rollback', 'verifyRollback'])
    expect(adapter.value).toBe('initial')
  })

  it('verifies first when recovering a rollback that may already have completed', async () => {
    const adapter = new FakeAdapter()
    const input = request('recover-verifying')
    const planned = await new LifecycleManager({ adapters: [adapter] }).plan(input)
    const initial: StoredState = {
      ...emptyState(),
      revision: 1,
      transactions: {
        [input.requestId]: {
          requestId: input.requestId,
          requestFingerprint: planned.requestFingerprint,
          phase: 'verifying-rollback',
          adapterId: adapter.id,
          targetInstanceId: input.targetInstanceId,
          artifactDigest: planned.plan.artifactDigest,
          planDigest: planned.planDigest,
          plan: planned.plan as unknown as JsonValue,
          executionId: 'execution-verifying' as ExecutionId,
          snapshot: { ref: { value: 'initial' } },
          failure: { code: 'UNEXPECTED', message: 'crash', phase: 'rolling-back' },
        },
      },
    }
    adapter.calls = []
    const manager = new LifecycleManager({ adapters: [adapter], state: new MemoryStateStore(initial) })
    await manager.recover()
    expect(adapter.calls).toEqual(['verifyRollback'])
  })
})

describe('canonical identities', () => {
  it('is stable across object key order and separates changed plans', () => {
    expect(requestFingerprint({ b: 2, a: 1 })).toBe(requestFingerprint({ a: 1, b: 2 }))
    expect(planDigest({ operations: [{ a: 1 }] })).not.toBe(planDigest({ operations: [{ a: 2 }] }))
  })
})
