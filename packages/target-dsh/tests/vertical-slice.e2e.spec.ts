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
  sourceCheckoutCommand,
  targetInstanceId,
  type ProbeMode,
} from '../src/index.ts'

const checkout = process.env.DSH_CHECKOUT
const run = checkout === undefined ? describe.skip : describe
const fixture = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'dsh-lifecycle-probe')

function request(home: string, mode: ProbeMode): ChangeRequest {
  return {
    requestId: `e2e-${mode}` as RequestId,
    targetInstanceId: targetInstanceId(home),
    intent: { adapterId: 'dsh', action: 'add', sourcePath: fixture, mode },
  }
}

run('DSH isolated vertical slice', () => {
  it.each([
    ['healthy', 'committed', undefined],
    ['activation-failure', 'quarantined', true],
    ['health-failure', 'quarantined', true],
  ] as const)('runs %s through lifecycle with %s outcome', async (mode, status, restored) => {
    const root = await mkdtemp(join(tmpdir(), `deepsync-${mode}-`))
    const home = join(root, 'dsh-home')
    try {
      const instance = await createIsolatedDshInstance(sourceCheckoutCommand(checkout!), home)
      const detection = await detectDsh(instance)
      expect(detection.target.version).toBe('0.1.1-rc.2')
      expect(detection.evidence.every(item => item.status === 'pass')).toBe(true)
      const adapter = new DshTargetAdapter(instance)
      const manager = new LifecycleManager({ adapters: [adapter] })
      const result = await manager.execute(request(home, mode))
      expect(result.status, JSON.stringify(result)).toBe(status)
      if (restored !== undefined && result.status === 'quarantined') expect(result.restored).toBe(restored)
      const state = await manager.state()
      if (status === 'committed') expect(state.lastKnownGood[targetInstanceId(home)]).toBeDefined()
      else expect(Object.keys(state.quarantined)).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
