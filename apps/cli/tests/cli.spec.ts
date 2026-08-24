import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { packLocalDshArtifact } from '@deepsync/target-dsh'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executionExitCode, EXIT_CODES, help, main, resolvePluginArtifact, VERSION } from '../src/index.ts'

afterEach(() => vi.restoreAllMocks())

describe('DeepSync CLI', () => {
  it('prints version and help', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(['--version'])).toBe(0)
    expect(output).toHaveBeenCalledWith(`${VERSION}\n`)
    expect(help()).toContain('plan add')
  })

  it('reports empty state as structured JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-cli-test-'))
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect(await main(['status', '--json', '--state', join(directory, 'state.json')])).toBe(0)
      expect(String(output.mock.calls[0]?.[0])).toContain('"transactions": []')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('validates author plugins with stable structured output and exits', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const fixture = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'dsh-lifecycle-probe')
    expect(await main(['plugin', 'validate', fixture, '--json'])).toBe(EXIT_CODES.success)
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ command: 'plugin validate', valid: true, pluginId: 'dsh-lifecycle-probe' })
    expect(await main(['doctor', 'plugin', join(fixture, 'missing.tgz'), '--json'])).toBe(EXIT_CODES.doctorUnhealthy)
    expect(JSON.parse(String(output.mock.calls[1]?.[0]))).toMatchObject({ command: 'doctor plugin', valid: false, issues: [{ code: 'INPUT_NOT_FOUND' }] })
  })

  it('resolves an exact GitHub release artifact through the normal planning resolver', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-cli-github-'))
    const fixture = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'dsh-lifecycle-probe')
    try {
      const packed = await packLocalDshArtifact(fixture, join(directory, 'packed'))
      const local = await resolvePluginArtifact({ schemaVersion: 1, kind: 'local-artifact', path: packed.artifactPath, digest: packed.artifactDigest }, join(directory, 'local-cache'))
      expect(local.artifact.artifactDigest).toBe(packed.artifactDigest)
      expect(local.artifact.artifactPath).not.toBe(packed.artifactPath)
      const bytes = await readFile(packed.artifactPath)
      const fetcher = vi.fn(async () => new Response(bytes, { status: 200 }))
      const resolved = await resolvePluginArtifact({
        schemaVersion: 1,
        kind: 'github-release',
        owner: 'external-author',
        repository: 'plugin',
        tag: 'v1.0.0',
        asset: 'plugin.tgz',
        digest: packed.artifactDigest,
      }, join(directory, 'downloads'), fetcher)
      expect(resolved.artifact.artifactDigest).toBe(packed.artifactDigest)
      expect(resolved.source).toMatchObject({ kind: 'github-release', tag: 'v1.0.0', asset: 'plugin.tgz' })
      expect(fetcher).toHaveBeenCalledWith('https://github.com/external-author/plugin/releases/download/v1.0.0/plugin.tgz', { redirect: 'follow' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('maps lifecycle terminal outcomes to stable exit codes', () => {
    const digest = 'sha256:test' as never
    expect(executionExitCode({ status: 'committed', planDigest: digest, observation: { value: {} }, replayed: false })).toBe(EXIT_CODES.success)
    expect(executionExitCode({ status: 'rejected', planDigest: digest, reason: 'invalid', replayed: false })).toBe(EXIT_CODES.applyRejected)
    expect(executionExitCode({ status: 'quarantined', planDigest: digest, reason: 'unhealthy', restored: true, replayed: false })).toBe(EXIT_CODES.applyQuarantined)
  })

  it('returns stable structured usage errors, including parser failures', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await main(['unknown', '--json'])).toBe(2)
    expect(String(error.mock.calls[0]?.[0])).toContain('USAGE')
    expect(await main(['status', '--state', '--json'])).toBe(2)
    expect(String(error.mock.calls[1]?.[0])).toContain('requires a value')
  })
})
