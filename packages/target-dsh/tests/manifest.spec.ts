import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDshBundleManifest } from '../src/index.ts'

describe('DSH bundle manifest', () => {
  it('validates the lifecycle probe identity and confined patch', async () => {
    const fixture = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'dsh-lifecycle-probe')
    const manifest = await readDshBundleManifest(fixture)
    expect(manifest.packageName).toBe('@deepsync/fixture-dsh-lifecycle-probe')
    expect(manifest.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
  })
})
