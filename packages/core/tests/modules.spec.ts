import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactDigest, DeepSyncLockfile, PlanDigest, PluginId, TargetInstanceId } from '@deepsync/contracts'
import { describe, expect, it } from 'vitest'
import {
  DeepSyncError,
  FileRunLock,
  JsonFileStateStore,
  TargetRegistry,
  canonicalJson,
  emptyState,
  evaluateCapabilities,
  healthReport,
  orderDependencies,
  parseLockfile,
  serializeLockfile,
  validatePluginManifest,
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

describe('compatibility and health dimensions', () => {
  it('keeps required and optional capability outcomes distinct', () => {
    const report = evaluateCapabilities([
      { id: 'required', portability: 'portable', requirement: 'required' },
      { id: 'optional', portability: 'target-specific', requirement: 'optional' },
    ], [{ id: 'required', portability: 'portable', requirement: 'required' }], '2026-08-24T00:00:00Z')
    expect(report).toMatchObject({ compatible: true, requiredSatisfied: true })
    expect(report.evidence.map(item => item.status)).toEqual(['pass', 'warn'])
    expect(healthReport(report.evidence).healthy).toBe(true)
  })

  it('rejects a missing required capability', () => {
    expect(evaluateCapabilities([{ id: 'missing', portability: 'portable', requirement: 'required' }], [], '2026-08-24T00:00:00Z')).toMatchObject({ compatible: false })
  })
})

describe('manifest and target registry', () => {
  it('validates plugin identity and disposes target registrations', () => {
    const manifest = validatePluginManifest({ schemaVersion: 1, id: 'plugin' as never, packageName: 'plugin', version: '1.0.0', capabilities: [], targets: {} })
    expect(manifest.packageName).toBe('plugin')
    const registry = new TargetRegistry()
    const dispose = registry.register({ id: 'target' as never, target: 'fake', version: '1', root: '/', metadata: {}, capabilities: [] })
    expect(registry.list()).toHaveLength(1)
    expect(() => registry.register({ id: 'target' as never, target: 'fake', version: '1', root: '/', metadata: {}, capabilities: [] })).toThrow(/already registered/u)
    dispose()
    expect(registry.list()).toEqual([])
  })

  it('rejects invalid JSON and invalid plugin identity', () => {
    expect(() => canonicalJson({ invalid: undefined } as never)).toThrowError(DeepSyncError)
    expect(() => validatePluginManifest({ schemaVersion: 1, id: 'plugin' as never, packageName: '', version: '1', capabilities: [], targets: {} })).toThrow(/required/u)
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

  it('rejects malformed durable maps with STATE_CORRUPT', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-corrupt-'))
    const filename = join(directory, 'state.json')
    try {
      await writeFile(filename, JSON.stringify({ schemaVersion: 1, revision: 0, transactions: [], quarantined: {}, lastKnownGood: {} }))
      await expect(new JsonFileStateStore(filename).load()).rejects.toMatchObject({ code: 'STATE_CORRUPT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes independent managers with a cross-process file lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-lock-'))
    const filename = join(directory, 'run.lock')
    let releaseFirst!: () => void
    const firstMayExit = new Promise<void>(resolve => { releaseFirst = resolve })
    let firstEntered!: () => void
    const firstIsInside = new Promise<void>(resolve => { firstEntered = resolve })
    const events: string[] = []
    try {
      const first = new FileRunLock(filename).withExclusive(async () => {
        events.push('first-enter')
        firstEntered()
        await firstMayExit
        events.push('first-exit')
      })
      await firstIsInside
      const second = new FileRunLock(filename).withExclusive(async () => { events.push('second-enter') })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(events).toEqual(['first-enter'])
      releaseFirst()
      await Promise.all([first, second])
      expect(events).toEqual(['first-enter', 'first-exit', 'second-enter'])
    } finally {
      releaseFirst()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
