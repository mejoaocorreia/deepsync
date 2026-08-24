import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import type { ArtifactDigest, ChangeRequest, RequestId } from '@deepsync/contracts'
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
} from '../src/index.ts'

const checkout = process.env.DSH_CHECKOUT
const run = checkout === undefined ? describe.skip : describe
const fixture = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'dsh-lifecycle-probe')
type FixtureMode = 'healthy' | 'activation-failure' | 'health-failure'

async function sourceForMode(root: string, mode: FixtureMode): Promise<string> {
  const source = join(root, `source-${mode}-${crypto.randomUUID()}`)
  await cp(fixture, source, { recursive: true })
  const patch = join(source, 'cordis.patch.yml')
  await writeFile(patch, (await readFile(patch, 'utf8')).replace('mode: healthy', `mode: ${mode}`))
  return source
}

function request(instance: IsolatedDshInstance, artifactPath: string, digest: ArtifactDigest, id: string): ChangeRequest {
  return {
    requestId: id as RequestId,
    targetInstanceId: targetInstanceId(instance),
    intent: { schemaVersion: 1, adapterId: 'dsh', action: 'add', artifact: { schemaVersion: 1, kind: 'packed-artifact', path: artifactPath, digest } },
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
      const artifact = await packLocalDshArtifact(await sourceForMode(root, mode), join(root, 'artifacts'))
      const instance = await createIsolatedDshInstance(sourceCheckoutCommand(checkout!), join(root, 'dsh-home'))
      const detection = await detectDsh(instance)
      expect(detection.target.version).toBe('0.1.1-rc.2')
      expect(detection.evidence.every(item => item.status === 'pass')).toBe(true)
      const manager = new LifecycleManager({ adapters: [new DshTargetAdapter(instance)] })
      const result = await manager.execute(request(instance, artifact.artifactPath, artifact.artifactDigest, `e2e-${mode}`))
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
      const healthy = await packLocalDshArtifact(await sourceForMode(root, 'healthy'), join(root, 'healthy-artifacts'))
      const unhealthy = await packLocalDshArtifact(await sourceForMode(root, 'health-failure'), join(root, 'unhealthy-artifacts'))
      const instance = await createIsolatedDshInstance(sourceCheckoutCommand(checkout!), join(root, 'dsh-home'))
      const adapter = new DshTargetAdapter(instance)
      const manager = new LifecycleManager({ adapters: [adapter] })
      expect(await manager.execute(request(instance, healthy.artifactPath, healthy.artifactDigest, 'lkg-healthy'))).toMatchObject({ status: 'committed' })
      expect(await manager.execute(request(instance, unhealthy.artifactPath, unhealthy.artifactDigest, 'lkg-failure'))).toMatchObject({ status: 'quarantined', restored: true })
      const state = await manager.state()
      const lkg = state.lastKnownGood[targetInstanceId(instance)]?.ref as Readonly<Record<string, unknown>>
      expect(lkg.profileDigest).toBe(await profileTreeDigest(profileDirectory(instance)))
      const planned = await manager.plan(request(instance, healthy.artifactPath, healthy.artifactDigest, 'observe'))
      expect((await adapter.observe(planned.plan)).value).toMatchObject({ installed: true, desiredActivation: true, pinnedArtifact: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)
})
