import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { packLocalDshArtifact } from '@deepsync/target-dsh'
import { describe, expect, it } from 'vitest'
import { validatePluginInput } from '../src/index.ts'

const fixture = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'dsh-lifecycle-probe')

describe('plugin author validation', () => {
  it('validates source directories and complete packed artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-doctor-plugin-'))
    try {
      const source = await validatePluginInput(fixture)
      expect(source).toMatchObject({ valid: true, inputKind: 'directory', pluginId: 'dsh-lifecycle-probe' })
      expect(await validatePluginInput(resolve(import.meta.dirname, '..', '..', '..', 'docs', 'templates', 'dsh-plugin'))).toMatchObject({ valid: true, inputKind: 'directory', pluginId: 'example-ready' })
      const artifact = await packLocalDshArtifact(fixture, join(directory, 'artifacts'))
      expect(await validatePluginInput(artifact.artifactPath)).toMatchObject({ valid: true, inputKind: 'artifact', artifactDigest: artifact.artifactDigest })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('returns stable issue codes, JSON Pointer paths, and remediation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-doctor-invalid-'))
    try {
      await cp(fixture, directory, { recursive: true })
      const filename = join(directory, 'deepsync.manifest.json')
      const manifest = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>
      manifest.version = 'invalid'
      await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`)
      const report = await validatePluginInput(directory)
      expect(report.valid).toBe(false)
      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'SCHEMA_PATTERN', path: '/version', remediation: expect.any(String) }),
      ]))
      expect(await validatePluginInput(join(directory, 'missing.tgz'))).toMatchObject({ valid: false, issues: [expect.objectContaining({ code: 'INPUT_NOT_FOUND' })] })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
