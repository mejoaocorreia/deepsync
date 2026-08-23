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
import { LifecycleManager, MemoryStateStore, planDigest, requestFingerprint } from '../src/index.ts'

const TARGET = 'fake-instance' as TargetInstanceId
const ARTIFACT = `sha256:${'a'.repeat(64)}` as ArtifactDigest
const now = '2026-08-24T00:00:00.000Z'
const pass = (id: string): Evidence => ({ checkId: id, status: 'pass', summary: id, observedAt: now })

function request(id: string, value = 'next'): ChangeRequest {
  return { requestId: id as RequestId, targetInstanceId: TARGET, intent: { adapterId: 'fake', value } }
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
    return { schemaVersion: 1, adapterId: this.id, targetInstanceId: TARGET, artifactDigest: ARTIFACT, operations: [{ set: intent.value ?? null }], metadata: {} }
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
  it('commits in lifecycle order and replays idempotently without adapter calls', async () => {
    const adapter = new FakeAdapter()
    const manager = new LifecycleManager({ adapters: [adapter] })
    const first = await manager.execute(request('one'))
    expect(first).toMatchObject({ status: 'committed', replayed: false })
    expect(adapter.value).toBe('next')
    expect(adapter.calls).toEqual(['plan', 'validate', 'snapshot', 'apply', 'observe', 'health'])
    const count = adapter.calls.length
    const replay = await manager.execute(request('one'))
    expect(replay).toMatchObject({ status: 'committed', replayed: true })
    expect(adapter.calls).toHaveLength(count)
    expect((await manager.state()).lastKnownGood[TARGET]).toBeDefined()
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

  it('rolls back an unhealthy observation and blocks the same digest', async () => {
    const adapter = new FakeAdapter()
    adapter.unhealthy = true
    const manager = new LifecycleManager({ adapters: [adapter] })
    const first = await manager.execute(request('unhealthy'))
    expect(first).toMatchObject({ status: 'quarantined', restored: true, reason: 'fixture unhealthy' })
    await expect(manager.execute(request('same-plan-new-request'))).rejects.toMatchObject({ code: 'PLAN_QUARANTINED' })
  })

  it('rejects request id reuse with different intent before adapter work', async () => {
    const adapter = new FakeAdapter()
    const manager = new LifecycleManager({ adapters: [adapter] })
    await manager.execute(request('same-id', 'one'))
    const count = adapter.calls.length
    await expect(manager.execute(request('same-id', 'two'))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(adapter.calls).toHaveLength(count)
  })

  it('recovers an uncertain applied transaction by rollback without replaying apply', async () => {
    const adapter = new FakeAdapter()
    const store = new MemoryStateStore()
    const manager = new LifecycleManager({ adapters: [adapter], state: store })
    adapter.failAt = 'observe'
    await manager.execute(request('recover-source'))
    const state = await store.load()
    const quarantined = state.transactions['recover-source']
    expect(quarantined?.phase).toBe('quarantined')
    expect(await manager.recover()).toEqual([])
  })
})

describe('canonical identities', () => {
  it('is stable across object key order and separates changed plans', () => {
    expect(requestFingerprint({ b: 2, a: 1 })).toBe(requestFingerprint({ a: 1, b: 2 }))
    expect(planDigest({ operations: [{ a: 1 }] })).not.toBe(planDigest({ operations: [{ a: 2 }] }))
  })
})
