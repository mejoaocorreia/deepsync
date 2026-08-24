import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIsolatedDshInstance, detectDsh, openIsolatedDshInstance, targetInstanceId, type DshCommand } from '../src/index.ts'

function fakeCommand(version = '0.1.1-rc.2'): DshCommand {
  const script = `const args=process.argv.slice(1); console.log(args.includes('--version') ? ${JSON.stringify(version)} : '[]')`
  return { command: process.execPath, prefixArgs: ['-e', script, '--'] }
}

describe('isolated DSH instance identity', () => {
  it('binds marker nonce and canonical home to the target id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepsync-isolation-'))
    try {
      const original = await createIsolatedDshInstance(fakeCommand(), join(root, 'original'))
      expect(targetInstanceId(await openIsolatedDshInstance(fakeCommand(), original.home))).toBe(targetInstanceId(original))
      await cp(original.home, join(root, 'copied'), { recursive: true })
      await expect(openIsolatedDshInstance(fakeCommand(), join(root, 'copied'))).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports unsupported versions as failed compatibility evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepsync-version-'))
    try {
      const instance = await createIsolatedDshInstance(fakeCommand('9.9.9'), join(root, 'home'))
      const detection = await detectDsh(instance)
      expect(detection.target.version).toBe('9.9.9')
      expect(detection.evidence.find(item => item.checkId === 'dsh.version')).toMatchObject({ status: 'fail' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
