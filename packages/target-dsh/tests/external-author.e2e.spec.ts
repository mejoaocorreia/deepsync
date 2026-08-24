import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { writeExternalPlugin } from '../../../scripts/external-plugin-fixture.mjs'

const checkout = process.env.DSH_CHECKOUT
const run = checkout === undefined ? describe.skip : describe
const root = resolve(import.meta.dirname, '..', '..', '..')
const packageDirectories = ['packages/contracts', 'packages/core', 'packages/doctor', 'packages/source-github', 'packages/target-dsh', 'apps/cli']

function pnpmInstall(cwd: string) {
  const args = ['install', '--offline', '--ignore-scripts']
  if (process.platform === 'win32') return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], { cwd, encoding: 'utf8', windowsHide: true })
  return spawnSync('pnpm', args, { cwd, encoding: 'utf8' })
}

function executeCli(cli: string, cwd: string, args: readonly string[]) {
  return spawnSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 240_000 })
}

run('packed external plugin author lifecycle', () => {
  it('validates, packs, commits, restores LKG, quarantines invalid health, and rolls back activation failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-external-author-'))
    try {
      const manifests = await Promise.all(packageDirectories.map(async packageDirectory => JSON.parse(await readFile(resolve(root, packageDirectory, 'package.json'), 'utf8')) as { name: string; version: string; bin?: { deepsync?: string } }))
      const archiveName = (manifest: { name: string; version: string }) => `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`
      const dependencies = Object.fromEntries(manifests.map(manifest => [manifest.name, `file:${resolve(root, 'artifacts', archiveName(manifest)).replaceAll('\\', '/')}`]))
      await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'external-deepsync-author', private: true, type: 'module', dependencies }, null, 2)}\n`)
      await writeFile(join(directory, 'pnpm-workspace.yaml'), ['packages:', '  - .', '', 'overrides:', ...Object.entries(dependencies).map(([name, specifier]) => `  '${name}': '${specifier}'`), ''].join('\n'))
      const installed = pnpmInstall(directory)
      expect(installed.status, installed.stderr || installed.stdout).toBe(0)
      const cliManifest = manifests.find(manifest => manifest.name === 'deepsync')!
      const cli = join(directory, 'node_modules', 'deepsync', cliManifest.bin!.deepsync!)
      const plugin = join(directory, 'third-party-plugin')
      const home = join(directory, 'dsh-home')
      const state = join(directory, 'state.json')
      const artifacts = join(directory, 'plugin-artifacts')

      await writeExternalPlugin(plugin, { version: '1.0.0', outcome: 'healthy' })
      const validated = executeCli(cli, directory, ['plugin', 'validate', plugin])
      expect(validated.status, validated.stderr || validated.stdout).toBe(0)
      expect(JSON.parse(validated.stdout)).toMatchObject({ valid: true, packageName: '@third-party/deepsync-readiness-plugin' })
      const healthyPlan = join(directory, 'healthy.plan.json')
      const plannedHealthy = executeCli(cli, directory, ['plan', 'add', plugin, '--dsh-root', checkout!, '--home', home, '--state', state, '--artifact-cache', artifacts, '--request-id', 'external-healthy', '--out', healthyPlan])
      expect(plannedHealthy.status, plannedHealthy.stderr || plannedHealthy.stdout).toBe(0)
      const appliedHealthy = executeCli(cli, directory, ['apply', healthyPlan, '--state', state])
      expect(appliedHealthy.status, appliedHealthy.stderr || appliedHealthy.stdout).toBe(0)
      expect(JSON.parse(appliedHealthy.stdout)).toMatchObject({ status: 'committed' })

      await writeExternalPlugin(plugin, { version: '1.0.1', outcome: 'invalid-health' })
      const invalidPlan = join(directory, 'invalid-health.plan.json')
      const plannedInvalid = executeCli(cli, directory, ['plan', 'add', plugin, '--dsh-root', checkout!, '--home', home, '--state', state, '--artifact-cache', artifacts, '--request-id', 'external-invalid-health', '--out', invalidPlan])
      expect(plannedInvalid.status, plannedInvalid.stderr || plannedInvalid.stdout).toBe(0)
      const appliedInvalid = executeCli(cli, directory, ['apply', invalidPlan, '--state', state])
      expect(appliedInvalid.status, appliedInvalid.stderr || appliedInvalid.stdout).toBe(21)
      expect(JSON.parse(appliedInvalid.stdout)).toMatchObject({ status: 'quarantined', restored: true })
      const status = executeCli(cli, directory, ['status', '--state', state])
      expect(status.status, status.stderr || status.stdout).toBe(0)
      const statusValue = JSON.parse(status.stdout) as { lastKnownGoodTargets: string[]; targetHeads: Record<string, string>; quarantined: Array<{ restored: boolean }> }
      expect(statusValue.lastKnownGoodTargets).toHaveLength(1)
      expect(Object.values(statusValue.targetHeads)).toEqual(['external-healthy'])
      expect(statusValue.quarantined).toEqual(expect.arrayContaining([expect.objectContaining({ restored: true })]))

      const failedPlugin = join(directory, 'activation-failure-plugin')
      const failedHome = join(directory, 'failed-dsh-home')
      const failedState = join(directory, 'failed-state.json')
      await writeExternalPlugin(failedPlugin, { version: '1.0.2', outcome: 'activation-failure' })
      const failedPlan = join(directory, 'activation-failure.plan.json')
      const plannedFailure = executeCli(cli, directory, ['plan', 'add', failedPlugin, '--dsh-root', checkout!, '--home', failedHome, '--state', failedState, '--artifact-cache', artifacts, '--request-id', 'external-activation-failure', '--out', failedPlan])
      expect(plannedFailure.status, plannedFailure.stderr || plannedFailure.stdout).toBe(0)
      const appliedFailure = executeCli(cli, directory, ['apply', failedPlan, '--state', failedState])
      expect(appliedFailure.status, appliedFailure.stderr || appliedFailure.stdout).toBe(21)
      expect(JSON.parse(appliedFailure.stdout)).toMatchObject({ status: 'quarantined', restored: true })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 600_000)
})
