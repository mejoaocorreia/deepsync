import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { Evidence, TargetInstance, TargetInstanceId } from '@deepsync/contracts'
import { DeepSyncError } from '@deepsync/core'
import { ISOLATED_PROFILE, SUPPORTED_DSH_VERSION } from './constants.ts'
import type { DshCommand } from './process.ts'
import { runCommand, scrubEnvironment } from './process.ts'

const MARKER = '.deepsync-isolated.json'

interface IsolationMarker {
  readonly schemaVersion: 2
  readonly createdBy: 'deepsync'
  readonly canonicalHome: string
  readonly profile: typeof ISOLATED_PROFILE
  readonly instanceNonce: string
}

export interface IsolatedDshInstance {
  readonly command: DshCommand
  readonly home: string
  readonly profile: typeof ISOLATED_PROFILE
  readonly instanceNonce: string
}

function isolatedEnvironment(instance: Pick<IsolatedDshInstance, 'home'>): NodeJS.ProcessEnv {
  return scrubEnvironment({
    DSH_HOME: instance.home,
    HOME: instance.home,
    USERPROFILE: instance.home,
    TEMP: join(instance.home, '.tmp'),
    TMP: join(instance.home, '.tmp'),
    npm_config_cache: join(instance.home, '.cache', 'npm'),
  })
}

async function readMarker(home: string): Promise<IsolationMarker> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(home, MARKER), 'utf8'))
  } catch (error) {
    throw new DeepSyncError('TARGET_MISMATCH', `DSH home has no valid DeepSync isolation marker: ${home}`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeepSyncError('TARGET_MISMATCH', `DSH isolation marker is malformed: ${home}`)
  const marker = value as Partial<IsolationMarker>
  if (marker.schemaVersion !== 2 || marker.createdBy !== 'deepsync' || marker.profile !== ISOLATED_PROFILE
    || typeof marker.canonicalHome !== 'string' || typeof marker.instanceNonce !== 'string' || marker.instanceNonce.length < 16) {
    throw new DeepSyncError('TARGET_MISMATCH', `DSH isolation marker is malformed or obsolete: ${home}`)
  }
  return marker as IsolationMarker
}

export async function createIsolatedDshInstance(command: DshCommand, home: string): Promise<IsolatedDshInstance> {
  const requestedHome = resolve(home)
  await mkdir(dirname(requestedHome), { recursive: true })
  try {
    const existing = await readdir(requestedHome)
    if (existing.length > 0) throw new DeepSyncError('TARGET_MISMATCH', `Isolated DSH home must be empty: ${requestedHome}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(requestedHome)
  }
  const canonicalHome = await realpath(requestedHome)
  const instanceNonce = crypto.randomUUID()
  const marker: IsolationMarker = { schemaVersion: 2, createdBy: 'deepsync', canonicalHome, profile: ISOLATED_PROFILE, instanceNonce }
  await writeFile(join(canonicalHome, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  const profile = join(canonicalHome, 'profiles', ISOLATED_PROFILE)
  await mkdir(profile, { recursive: true })
  await mkdir(join(canonicalHome, '.tmp'), { recursive: true })
  await Promise.all([
    writeFile(join(profile, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-deepsync-test', private: true, dsh: { profile: { bundles: [] } } }, null, 2)}\n`),
    writeFile(join(profile, 'cordis.yml'), '[]\n'),
    writeFile(join(profile, 'cordis.patch.yml'), '[]\n'),
    writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'),
  ])
  const instance: IsolatedDshInstance = { command, home: canonicalHome, profile: ISOLATED_PROFILE, instanceNonce }
  const result = await runCommand(command, ['--profile', ISOLATED_PROFILE, '--dump-config'], isolatedEnvironment(instance))
  if (result.exitCode !== 0) throw new DeepSyncError('TARGET_UNSUPPORTED', `Failed to initialize isolated DSH profile: ${result.stderr || result.stdout}`)
  return instance
}

export async function openIsolatedDshInstance(command: DshCommand, home: string): Promise<IsolatedDshInstance> {
  const canonicalHome = await realpath(resolve(home))
  const marker = await readMarker(canonicalHome)
  const instance: IsolatedDshInstance = { command, home: canonicalHome, profile: ISOLATED_PROFILE, instanceNonce: marker.instanceNonce }
  await assertIsolated(instance)
  return instance
}

export async function assertIsolated(instance: IsolatedDshInstance): Promise<void> {
  const canonicalHome = await realpath(instance.home)
  const marker = await readMarker(canonicalHome)
  if (marker.canonicalHome !== canonicalHome || instance.home !== canonicalHome || marker.instanceNonce !== instance.instanceNonce
    || marker.profile !== instance.profile) throw new DeepSyncError('TARGET_MISMATCH', `DSH isolation marker does not bind this instance: ${instance.home}`)
  const profilePackage = JSON.parse(await readFile(join(profileDirectory(instance), 'package.json'), 'utf8')) as { name?: unknown; private?: unknown; dsh?: { profile?: { bundles?: unknown } } }
  if (profilePackage.name !== 'dsh-profile-deepsync-test' || profilePackage.private !== true || !Array.isArray(profilePackage.dsh?.profile?.bundles)) {
    throw new DeepSyncError('TARGET_MISMATCH', `DSH isolated profile layout is invalid: ${instance.home}`)
  }
  const profileEntries = await readdir(join(instance.home, 'profiles'), { withFileTypes: true })
  const unexpected = profileEntries.filter(entry => entry.isDirectory() && entry.name !== instance.profile && entry.name !== 'node_modules')
  if (unexpected.length > 0) throw new DeepSyncError('TARGET_MISMATCH', `DSH home contains unexpected profiles: ${unexpected.map(entry => entry.name).join(', ')}`)
}

export function profileDirectory(instance: IsolatedDshInstance): string {
  return join(instance.home, 'profiles', instance.profile)
}

export async function profileTreeDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolutePath = join(directory, entry.name)
      const details = await lstat(absolutePath)
      if (details.isSymbolicLink()) {
        hash.update(`link\0${relativePath}\0${await readlink(absolutePath)}\0`)
      } else if (details.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`)
        await visit(absolutePath, relativePath)
      } else if (details.isFile()) {
        hash.update(`file\0${relativePath}\0${details.size}\0`)
        hash.update(await readFile(absolutePath))
        hash.update('\0')
      } else {
        throw new DeepSyncError('TARGET_MISMATCH', `Unsupported profile entry type: ${absolutePath}`)
      }
    }
  }
  await visit(root, '')
  return `sha256:${hash.digest('hex')}`
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

export function targetInstanceId(instance: IsolatedDshInstance): TargetInstanceId {
  return `dsh:${createHash('sha256').update(`${instance.home.toLowerCase()}\0${instance.instanceNonce}`).digest('hex').slice(0, 32)}` as TargetInstanceId
}

export async function detectDsh(instance: IsolatedDshInstance): Promise<{ readonly target: TargetInstance; readonly evidence: readonly Evidence[] }> {
  await assertIsolated(instance)
  const observedAt = new Date().toISOString()
  const versionResult = await runCommand(instance.command, ['--version'], isolatedEnvironment(instance))
  const version = versionResult.stdout.trim()
  const versionOk = versionResult.exitCode === 0 && version === SUPPORTED_DSH_VERSION
  const dump = await runCommand(instance.command, ['--profile', instance.profile, '--dump-config'], isolatedEnvironment(instance))
  const capabilities = [
    { id: 'dsh.profile.bundle', portability: 'target-specific' as const, requirement: 'required' as const, version },
    { id: 'dsh.config.dump', portability: 'target-specific' as const, requirement: 'required' as const },
    { id: 'extension.lifecycle.transactional', portability: 'portable' as const, requirement: 'required' as const },
  ]
  const evidence: Evidence[] = [
    { checkId: 'dsh.isolation-marker', status: 'pass', summary: `Bound isolated profile ${instance.profile}`, observedAt, data: { home: instance.home, instanceNonce: instance.instanceNonce } },
    { checkId: 'dsh.version', status: versionOk ? 'pass' : 'fail', summary: `Observed DSH ${version || 'unknown'}`, observedAt, data: { expected: SUPPORTED_DSH_VERSION, observed: version } },
    { checkId: 'dsh.dump-config', status: dump.exitCode === 0 ? 'pass' : 'fail', summary: dump.exitCode === 0 ? 'Profile composition is readable' : 'Profile composition failed', observedAt },
  ]
  return { target: { id: targetInstanceId(instance), target: 'dsh', version, root: instance.home, metadata: { profile: instance.profile, isolated: true, instanceNonce: instance.instanceNonce }, capabilities }, evidence }
}

export { isolatedEnvironment }
