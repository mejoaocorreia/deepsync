import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import type { ChangeRequest, RequestId } from '@deepsync/contracts'
import { LifecycleManager } from '@deepsync/core'
import { describe, expect, it } from 'vitest'
import {
  createIsolatedDshInstance,
  detectDsh,
  DshTargetAdapter,
  packLocalDshArtifact,
  profileDirectory,
  profileTreeDigest,
  sourceCheckoutCommand,
  targetInstanceId,
  type IsolatedDshInstance,
  type ProbeMode,
} from '../src/index.ts'

const checkout = process.env.DSH_CHECKOUT
const run = checkout === undefined ? describe.skip : describe
const fixture = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'dsh-lifecycle-probe')

function request(instance: IsolatedDshInstance, artifactPath: string, mode: ProbeMode, id = `e2e-${mode}`): ChangeRequest {
  return {
    requestId: id as RequestId,
    targetInstanceId: targetInstanceId(instance),
    intent: { adapterId: 'dsh', action: 'add', artifactPath, mode },
  }
}

run('DSH isolated vertical slice', () => {
  it.each([
    ['healthy', 'committed', undefined],
    ['activation-failure', 'quarantined', true],
    ['health-failure', 'quarantined', true],
  ] as const)('runs packed %s artifact through lifecycle with %s outcome', async (mode, status, restored) => {
    const root = await mkdtemp(join(tmpdir(), `deepsync-${mode}-`))
    try {
      const artifact = await packLocalDshArtifact(fixture, join(root, 'artifacts'))
      const instance = await createIsolatedDshInstance(sourceCheckoutCommand(checkout!), join(root, 'dsh-home'))
      const detection = await detectDsh(instance)
      expect(detection.target.version).toBe('0.1.1-rc.2')
      expect(detection.evidence.every(item => item.status === 'pass')).toBe(true)
      const manager = new LifecycleManager({ adapters: [new DshTargetAdapter(instance)] })
      const result = await manager.execute(request(instance, artifact.artifactPath, mode))
      expect(result.status, JSON.stringify(result)).toBe(status)
      if (restored !== undefined && result.status === 'quarantined') expect(result.restored).toBe(restored)
      const state = await manager.state()
      if (status === 'committed') {
        expect(state.lastKnownGood[targetInstanceId(instance)]).toBeDefined()
        expect(state.targetHeads[targetInstanceId(instance)]).toBe(`e2e-${mode}`)
      } else {
        expect(Object.values(state.quarantined)[0]).toMatchObject({ artifactDigest: artifact.artifactDigest, restored: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('restores the prior committed LKG after a later staged health failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepsync-lkg-'))
    try {
      const artifact = await packLocalDshArtifact(fixture, join(root, 'artifacts'))
      const instance = await createIsolatedDshInstance(sourceCheckoutCommand(checkout!), join(root, 'dsh-home'))
      const adapter = new DshTargetAdapter(instance)
      const manager = new LifecycleManager({ adapters: [adapter] })
      expect(await manager.execute(request(instance, artifact.artifactPath, 'healthy', 'lkg-healthy'))).toMatchObject({ status: 'committed' })
      expect(await manager.execute(request(instance, artifact.artifactPath, 'health-failure', 'lkg-failure'))).toMatchObject({ status: 'quarantined', restored: true })
      const state = await manager.state()
      const lkg = state.lastKnownGood[targetInstanceId(instance)]?.ref as Readonly<Record<string, unknown>>
      expect(lkg.profileDigest).toBe(await profileTreeDigest(profileDirectory(instance)))
      expect((await adapter.observe((await manager.plan(request(instance, artifact.artifactPath, 'healthy', 'observe'))).plan)).value).toMatchObject({ installed: true, desiredActivation: true, pinnedArtifact: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)
})
