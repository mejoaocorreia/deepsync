import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { help, main, VERSION } from '../src/index.ts'

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

  it('returns a structured command error', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await main(['unknown', '--json'])).toBe(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('COMMAND_FAILED')
  })
})
