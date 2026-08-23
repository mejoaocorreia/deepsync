import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactDigest, DeepSyncLockfile, PlanDigest, PluginId, TargetInstanceId } from '@deepsync/contracts'
import { describe, expect, it } from 'vitest'
import {
  DeepSyncError,
  JsonFileStateStore,
  emptyState,
  orderDependencies,
  parseLockfile,
  serializeLockfile,
} from '../src/index.ts'

describe('dependency graph', () => {
  it('orders dependencies before dependants', () => {
    expect(orderDependencies([{ id: 'plugin', dependencies: ['base'] }, { id: 'base', dependencies: [] }])).toEqual(['base', 'plugin'])
  })

  it('rejects cycles and missing dependencies', () => {
    expect(() => orderDependencies([{ id: 'a', dependencies: ['a'] }])).toThrowError(DeepSyncError)
    expect(() => orderDependencies([{ id: 'a', dependencies: ['missing'] }])).toThrowError(DeepSyncError)
  })
})

describe('lockfile', () => {
  it('serializes entries deterministically and parses them', () => {
    const entry = (id: string) => ({
      pluginId: id as PluginId,
      packageName: id,
      version: '1.0.0',
      source: { kind: 'local' },
      artifactDigest: `sha256:${id}` as ArtifactDigest,
      targetInstanceId: 'target' as TargetInstanceId,
      planDigest: `sha256:${id}` as PlanDigest,
      evidence: [],
    })
    const lock: DeepSyncLockfile = { schemaVersion: 1, entries: [entry('z'), entry('a')] }
    const text = serializeLockfile(lock)
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"z"'))
    expect(parseLockfile(text).entries).toHaveLength(2)
  })
})

describe('file state', () => {
  it('publishes one complete revision atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-state-'))
    const filename = join(directory, 'state.json')
    try {
      const store = new JsonFileStateStore(filename)
      const initial = await store.load()
      const next = { ...emptyState(), revision: 1 }
      await store.save(initial.revision, next)
      expect((await store.load()).revision).toBe(1)
      expect(JSON.parse(await readFile(filename, 'utf8')).schemaVersion).toBe(1)
      await expect(store.save(0, { ...next, revision: 2 })).rejects.toMatchObject({ code: 'STATE_CONFLICT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
