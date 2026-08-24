import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { Evidence, TargetInstance, TargetInstanceId } from '@deepsync/contracts'
import type { DshCommand } from './process.ts'
import { runCommand, scrubEnvironment } from './process.ts'

const MARKER = '.deepsync-isolated.json'
const PROFILE = 'deepsync-test'

export interface IsolatedDshInstance {
  readonly command: DshCommand
  readonly home: string
  readonly profile: typeof PROFILE
}

export async function createIsolatedDshInstance(command: DshCommand, home: string): Promise<IsolatedDshInstance> {
  await mkdir(dirname(home), { recursive: true })
  try {
    const existing = await readdir(home)
    if (existing.length > 0) throw new Error(`Isolated DSH home must be empty: ${home}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(home)
  }
  await writeFile(join(home, MARKER), `${JSON.stringify({ schemaVersion: 1, createdBy: 'deepsync' })}\n`, { encoding: 'utf8', mode: 0o600 })
  const profile = join(home, 'profiles', PROFILE)
  await mkdir(profile, { recursive: true })
  await Promise.all([
    writeFile(join(profile, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-deepsync-test', private: true, dsh: { profile: { bundles: [] } } }, null, 2)}\n`),
    writeFile(join(profile, 'cordis.yml'), '[]\n'),
    writeFile(join(profile, 'cordis.patch.yml'), '[]\n'),
    writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'),
  ])
  const instance: IsolatedDshInstance = { command, home: resolve(home), profile: PROFILE }
  const result = await runCommand(command, ['--profile', PROFILE, '--dump-config'], scrubEnvironment({ DSH_HOME: home }))
  if (result.exitCode !== 0) throw new Error(`Failed to initialize isolated DSH profile: ${result.stderr || result.stdout}`)
  return instance
}

export async function assertIsolated(instance: IsolatedDshInstance): Promise<void> {
  const marker = JSON.parse(await readFile(join(instance.home, MARKER), 'utf8')) as { createdBy?: string }
  if (marker.createdBy !== 'deepsync') throw new Error(`DSH home is not owned by DeepSync isolation: ${instance.home}`)
  if (instance.profile !== PROFILE) throw new Error(`Alpha.1 supports only the isolated ${PROFILE} profile`)
}

export function profileDirectory(instance: IsolatedDshInstance): string {
  return join(instance.home, 'profiles', instance.profile)
}

export async function snapshotProfile(instance: IsolatedDshInstance, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true })
  await cp(profileDirectory(instance), destination, { recursive: true, verbatimSymlinks: true })
}

export async function restoreProfile(instance: IsolatedDshInstance, source: string): Promise<void> {
  await rm(profileDirectory(instance), { recursive: true, force: true })
  await cp(source, profileDirectory(instance), { recursive: true, verbatimSymlinks: true })
}

export function targetInstanceId(home: string): TargetInstanceId {
  return `dsh:${createHash('sha256').update(resolve(home).toLowerCase()).digest('hex').slice(0, 24)}` as TargetInstanceId
}

export async function detectDsh(instance: IsolatedDshInstance): Promise<{ readonly target: TargetInstance; readonly evidence: readonly Evidence[] }> {
  await assertIsolated(instance)
  const observedAt = new Date().toISOString()
  const versionResult = await runCommand(instance.command, ['--version'], scrubEnvironment({ DSH_HOME: instance.home }))
  const version = versionResult.stdout.trim()
  const versionOk = versionResult.exitCode === 0 && version === '0.1.1-rc.2'
  const dump = await runCommand(instance.command, ['--profile', instance.profile, '--dump-config'], scrubEnvironment({ DSH_HOME: instance.home }))
  const capabilities = [
    { id: 'dsh.profile.bundle', portability: 'target-specific' as const, requirement: 'required' as const },
    { id: 'dsh.config.dump', portability: 'target-specific' as const, requirement: 'required' as const },
    { id: 'extension.lifecycle.transactional', portability: 'portable' as const, requirement: 'required' as const },
  ]
  const evidence: Evidence[] = [
    { checkId: 'dsh.version', status: versionOk ? 'pass' : 'fail', summary: `Observed DSH ${version || 'unknown'}`, observedAt, data: { expected: '0.1.1-rc.2', observed: version } },
    { checkId: 'dsh.dump-config', status: dump.exitCode === 0 ? 'pass' : 'fail', summary: dump.exitCode === 0 ? 'Profile composition is readable' : 'Profile composition failed', observedAt },
  ]
  return {
    target: { id: targetInstanceId(instance.home), target: 'dsh', version, root: instance.home, metadata: { profile: instance.profile, isolated: true }, capabilities },
    evidence,
  }
}
