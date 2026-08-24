import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  ChangePlan,
  ChangeRequest,
  Evidence,
  ExecutionId,
  JsonValue,
  RollbackVerification,
  TargetAdapter,
  TargetHealth,
  TargetObservation,
  TargetSnapshot,
} from '@deepsync/contracts'
import { assertIsolated, detectDsh, profileDirectory, restoreProfile, snapshotProfile, type IsolatedDshInstance } from './isolated.ts'
import { activateAndCheck, type ProbeMode } from './health.ts'
import { readDshBundleManifest } from './manifest.ts'
import { runCommand, scrubEnvironment } from './process.ts'

interface DshIntent {
  readonly adapterId: 'dsh'
  readonly action: 'add'
  readonly sourcePath: string
  readonly mode: ProbeMode
}

function intent(value: JsonValue): DshIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH intent must be an object')
  const candidate = value as unknown as Partial<DshIntent>
  if (candidate.adapterId !== 'dsh' || candidate.action !== 'add' || typeof candidate.sourcePath !== 'string'
    || !['healthy', 'activation-failure', 'health-failure'].includes(candidate.mode ?? '')) throw new Error('DSH add intent is invalid')
  return candidate as DshIntent
}

function metadata(plan: ChangePlan): { sourcePath: string; packageName: string; mode: ProbeMode } {
  return plan.metadata as unknown as { sourcePath: string; packageName: string; mode: ProbeMode }
}

async function dump(instance: IsolatedDshInstance): Promise<string> {
  const result = await runCommand(instance.command, ['--profile', instance.profile, '--dump-config'], scrubEnvironment({ DSH_HOME: instance.home }))
  if (result.exitCode !== 0) throw new Error(`DSH config validation failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export class DshTargetAdapter implements TargetAdapter {
  readonly id = 'dsh'

  constructor(readonly instance: IsolatedDshInstance) {}

  async plan(request: ChangeRequest): Promise<ChangePlan> {
    await assertIsolated(this.instance)
    const requested = intent(request.intent)
    const sourcePath = resolve(requested.sourcePath)
    const manifest = await readDshBundleManifest(sourcePath)
    return {
      schemaVersion: 1,
      adapterId: this.id,
      targetInstanceId: request.targetInstanceId,
      artifactDigest: manifest.artifactDigest,
      operations: [{ action: 'pnpm-add', packageName: manifest.packageName, sourcePath }],
      metadata: { sourcePath, packageName: manifest.packageName, mode: requested.mode },
    }
  }

  async validate(plan: ChangePlan): Promise<readonly Evidence[]> {
    await assertIsolated(this.instance)
    const observedAt = new Date().toISOString()
    const detected = await detectDsh(this.instance)
    if (detected.evidence.some(item => item.status === 'fail')) throw new Error('DSH compatibility checks failed')
    const details = metadata(plan)
    const manifest = await readDshBundleManifest(details.sourcePath)
    if (manifest.packageName !== details.packageName || manifest.artifactDigest !== plan.artifactDigest) throw new Error('Artifact changed after planning')
    await dump(this.instance)
    return [...detected.evidence, { checkId: 'dsh.bundle-manifest', status: 'pass', summary: `Validated ${manifest.packageName}`, observedAt }]
  }

  async snapshot(_plan: ChangePlan): Promise<TargetSnapshot> {
    const baselineDump = await dump(this.instance)
    const snapshotPath = join(this.instance.home, '.deepsync-snapshots', crypto.randomUUID(), 'profile')
    await snapshotProfile(this.instance, snapshotPath)
    return { ref: { snapshotPath, dumpHash: hash(baselineDump) } }
  }

  async apply(plan: ChangePlan, _executionId: ExecutionId): Promise<void> {
    await assertIsolated(this.instance)
    const details = metadata(plan)
    const result = await runCommand(
      this.instance.command,
      ['plugin', '--profile', this.instance.profile, 'add', details.sourcePath, '--save-exact'],
      scrubEnvironment({ DSH_HOME: this.instance.home }),
      120_000,
    )
    if (result.exitCode !== 0) throw new Error(`DSH package apply failed: ${result.stderr || result.stdout}`)
  }

  async observe(plan: ChangePlan): Promise<TargetObservation> {
    const details = metadata(plan)
    const config = await dump(this.instance)
    const packageJson = JSON.parse(await readFile(join(profileDirectory(this.instance), 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
    const installed = packageJson.dependencies?.[details.packageName] !== undefined
    const activated = packageJson.dsh?.profile?.bundles?.includes(details.packageName) === true
    return { value: { installed, desiredActivation: activated, configHash: hash(config), packageName: details.packageName, mode: details.mode } }
  }

  async health(plan: ChangePlan, observation: TargetObservation): Promise<TargetHealth> {
    const value = observation.value as Readonly<Record<string, JsonValue>>
    if (value.installed !== true || value.desiredActivation !== true) return { ok: false, reason: 'DSH package is not installed and selected', evidence: [] }
    return await activateAndCheck(this.instance, metadata(plan).mode)
  }

  async rollback(snapshot: TargetSnapshot, _executionId: ExecutionId): Promise<void> {
    const ref = snapshot.ref as Readonly<Record<string, JsonValue>>
    if (typeof ref.snapshotPath !== 'string') throw new Error('Snapshot has no profile path')
    await restoreProfile(this.instance, ref.snapshotPath)
  }

  async verifyRollback(snapshot: TargetSnapshot): Promise<RollbackVerification> {
    const ref = snapshot.ref as Readonly<Record<string, JsonValue>>
    if (typeof ref.dumpHash !== 'string') throw new Error('Snapshot has no dump hash')
    const restoredHash = hash(await dump(this.instance))
    const restored = restoredHash === ref.dumpHash
    const observedAt = new Date().toISOString()
    const evidence: Evidence[] = [{ checkId: 'dsh.rollback-config', status: restored ? 'pass' : 'fail', summary: restored ? 'Restored config matches baseline' : 'Restored config differs from baseline', observedAt, data: { expected: ref.dumpHash, observed: restoredHash } }]
    if (restored) return { restored: true, evidence }
    return { restored: false, reason: 'Restored DSH config hash differs', evidence }
  }

  async disposeSnapshots(): Promise<void> {
    await rm(join(this.instance.home, '.deepsync-snapshots'), { recursive: true, force: true })
    await mkdir(join(this.instance.home, '.deepsync-snapshots'), { recursive: true })
  }
}
