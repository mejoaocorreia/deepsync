import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executionExitCode, EXIT_CODES, help, main, VERSION } from '../src/index.ts'

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
