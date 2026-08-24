import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectPackedDshArtifact, packLocalDshArtifact, readDshBundleManifest } from '../src/index.ts'

const fixture = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'dsh-lifecycle-probe')

describe('DSH bundle artifacts', () => {
  it('validates identity, target declaration, and packed bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-pack-test-'))
    try {
      const manifest = await readDshBundleManifest(fixture)
      expect(manifest.packageName).toBe('@deepsync/fixture-dsh-lifecycle-probe')
      const packed = await packLocalDshArtifact(fixture, join(directory, 'cache'))
      const repeated = await packLocalDshArtifact(fixture, join(directory, 'repeated'))
      expect(packed.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect(repeated.artifactDigest).toBe(packed.artifactDigest)
      expect(packed.entries).toContain('package/index.js')
      expect((await inspectPackedDshArtifact(packed.artifactPath)).artifactDigest).toBe(packed.artifactDigest)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('changes digest when executable content changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-pack-mutation-'))
    const source = join(directory, 'source')
    try {
      await cp(fixture, source, { recursive: true })
      const first = await packLocalDshArtifact(source, join(directory, 'first'))
      await writeFile(join(source, 'index.js'), `${await readFile(join(source, 'index.js'), 'utf8')}\nexport const changed = true\n`)
      const second = await packLocalDshArtifact(source, join(directory, 'second'))
      expect(second.artifactDigest).not.toBe(first.artifactDigest)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('returns a structured error for malformed package metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-pack-malformed-'))
    try {
      await writeFile(join(directory, 'package.json'), '{not-json')
      await expect(readDshBundleManifest(directory)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects unsupported declared DSH versions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-pack-version-'))
    try {
      await cp(fixture, directory, { recursive: true })
      const filename = join(directory, 'deepsync.manifest.json')
      const manifest = JSON.parse(await readFile(filename, 'utf8')) as { targets: { dsh: { version: string } } }
      manifest.targets.dsh.version = '0.1.1'
      await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`)
      await expect(readDshBundleManifest(directory)).rejects.toMatchObject({ code: 'TARGET_UNSUPPORTED' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
