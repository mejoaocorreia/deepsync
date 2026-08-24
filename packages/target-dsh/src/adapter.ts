import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { DeepSyncError, evaluateCapabilities, artifactDigest } from '@deepsync/core'
import { inspectPackedDshArtifact } from './artifact.ts'
import { DSH_ADAPTER_ID } from './constants.ts'
import { assertIsolated, detectDsh, isolatedEnvironment, profileDirectory, profileTreeDigest, restoreProfile, snapshotProfile, targetInstanceId, type IsolatedDshInstance } from './isolated.ts'
import { activateAndCheck, type ProbeMode } from './health.ts'
import { runCommand } from './process.ts'

interface DshIntent {
  readonly adapterId: typeof DSH_ADAPTER_ID
  readonly action: 'add'
  readonly artifactPath: string
  readonly mode: ProbeMode
}

interface DshPlanMetadata {
  readonly artifactPath: string
  readonly packageName: string
  readonly version: string
  readonly mode: ProbeMode
  readonly healthPath: string
  readonly instanceNonce: string
}

function object(value: JsonValue, subject: string): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeepSyncError('PLAN_INVALID', `${subject} must be an object`)
  return value as Readonly<Record<string, JsonValue>>
}

function intent(value: JsonValue): DshIntent {
  const candidate = object(value, 'DSH intent')
  if (candidate.adapterId !== DSH_ADAPTER_ID || candidate.action !== 'add' || typeof candidate.artifactPath !== 'string'
    || !['healthy', 'activation-failure', 'health-failure'].includes(typeof candidate.mode === 'string' ? candidate.mode : '')) {
    throw new DeepSyncError('PLAN_INVALID', 'DSH add intent is invalid')
  }
  return candidate as unknown as DshIntent
}

function metadata(plan: ChangePlan): DshPlanMetadata {
  const candidate = object(plan.metadata, 'DSH plan metadata')
  if (typeof candidate.artifactPath !== 'string' || typeof candidate.packageName !== 'string' || typeof candidate.version !== 'string'
    || typeof candidate.healthPath !== 'string' || typeof candidate.instanceNonce !== 'string'
    || !['healthy', 'activation-failure', 'health-failure'].includes(typeof candidate.mode === 'string' ? candidate.mode : '')) {
    throw new DeepSyncError('PLAN_INVALID', 'DSH plan metadata is invalid')
  }
  return candidate as unknown as DshPlanMetadata
}

async function dump(instance: IsolatedDshInstance): Promise<string> {
  const result = await runCommand(instance.command, ['--profile', instance.profile, '--dump-config'], isolatedEnvironment(instance))
  if (result.exitCode !== 0) throw new DeepSyncError('TARGET_UNSUPPORTED', `DSH config validation failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export class DshTargetAdapter implements TargetAdapter {
  readonly id = DSH_ADAPTER_ID

  constructor(readonly instance: IsolatedDshInstance) {}

  async plan(request: ChangeRequest): Promise<ChangePlan> {
    await assertIsolated(this.instance)
    if (request.targetInstanceId !== targetInstanceId(this.instance)) throw new DeepSyncError('TARGET_MISMATCH', 'Change request does not identify this isolated DSH instance')
    const requested = intent(request.intent)
    const artifact = await inspectPackedDshArtifact(requested.artifactPath)
    return {
      schemaVersion: 1,
      adapterId: this.id,
      targetInstanceId: request.targetInstanceId,
      artifactDigest: artifact.artifactDigest,
      operations: [{ action: 'pnpm-add', packageName: artifact.packageName, artifactPath: artifact.artifactPath, saveExact: true }],
      metadata: { artifactPath: artifact.artifactPath, packageName: artifact.packageName, version: artifact.version, mode: requested.mode, healthPath: artifact.healthPath, instanceNonce: this.instance.instanceNonce },
    }
  }

  async validate(plan: ChangePlan): Promise<readonly Evidence[]> {
    await assertIsolated(this.instance)
    if (plan.adapterId !== this.id || plan.targetInstanceId !== targetInstanceId(this.instance)) throw new DeepSyncError('TARGET_MISMATCH', 'DSH plan does not identify this adapter instance')
    const observedAt = new Date().toISOString()
    const details = metadata(plan)
    if (details.instanceNonce !== this.instance.instanceNonce) throw new DeepSyncError('TARGET_MISMATCH', 'DSH plan belongs to a different isolation nonce')
    const detected = await detectDsh(this.instance)
    if (detected.evidence.some(item => item.status === 'fail')) throw new DeepSyncError('TARGET_UNSUPPORTED', 'DSH compatibility checks failed')
    const artifact = await inspectPackedDshArtifact(details.artifactPath)
    if (artifact.packageName !== details.packageName || artifact.version !== details.version || artifact.healthPath !== details.healthPath || artifact.artifactDigest !== plan.artifactDigest) {
      throw new DeepSyncError('ARTIFACT_INVALID', 'Artifact identity changed after planning')
    }
    const compatibility = evaluateCapabilities(artifact.deepSync.capabilities, detected.target.capabilities, observedAt)
    if (!compatibility.compatible) throw new DeepSyncError('TARGET_UNSUPPORTED', 'Artifact required capabilities are not available on this DSH instance')
    await dump(this.instance)
    return [
      ...detected.evidence,
      ...compatibility.evidence,
      { checkId: 'dsh.bundle-artifact', status: 'pass', summary: `Verified packed ${artifact.packageName}@${artifact.version}`, observedAt, data: { digest: artifact.artifactDigest, size: artifact.size, entries: artifact.entries } },
    ]
  }

  async snapshot(_plan: ChangePlan): Promise<TargetSnapshot> {
    await assertIsolated(this.instance)
    const baselineDump = await dump(this.instance)
    const snapshotPath = join(this.instance.home, '.deepsync-snapshots', crypto.randomUUID(), 'profile')
    const profileDigest = await profileTreeDigest(profileDirectory(this.instance))
    await snapshotProfile(this.instance, snapshotPath)
    return { ref: { snapshotPath, dumpHash: hash(baselineDump), profileDigest } }
  }

  async apply(plan: ChangePlan, executionId: ExecutionId): Promise<void> {
    await assertIsolated(this.instance)
    const details = metadata(plan)
    const artifact = await inspectPackedDshArtifact(details.artifactPath)
    if (artifact.artifactDigest !== plan.artifactDigest) throw new DeepSyncError('ARTIFACT_INVALID', 'Artifact bytes changed before apply')
    const artifactDirectory = join(profileDirectory(this.instance), '.deepsync-artifacts')
    await mkdir(artifactDirectory, { recursive: true })
    const stagedArtifact = join(artifactDirectory, `${plan.artifactDigest.slice('sha256:'.length)}.tgz`)
    const bytes = await readFile(artifact.artifactPath)
    await writeFile(stagedArtifact, bytes, { encoding: null, flag: 'wx', mode: 0o400 }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (artifactDigest(await readFile(stagedArtifact)) !== plan.artifactDigest) throw new DeepSyncError('ARTIFACT_INVALID', `Staged artifact collision for ${executionId}`)
    })
    const result = await runCommand(
      this.instance.command,
      ['plugin', '--profile', this.instance.profile, 'add', stagedArtifact, '--save-exact'],
      isolatedEnvironment(this.instance),
      120_000,
    )
    if (result.exitCode !== 0) throw new DeepSyncError('ARTIFACT_INVALID', `DSH package apply failed: ${result.stderr || result.stdout}`)
  }

  async observe(plan: ChangePlan): Promise<TargetObservation> {
    const details = metadata(plan)
    const config = await dump(this.instance)
    const packageJson = JSON.parse(await readFile(join(profileDirectory(this.instance), 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
    const installedSpecifier = packageJson.dependencies?.[details.packageName]
    const installed = installedSpecifier !== undefined
    const activated = packageJson.dsh?.profile?.bundles?.includes(details.packageName) === true
    const pinnedArtifact = installedSpecifier?.includes(plan.artifactDigest.slice('sha256:'.length)) === true
    return { value: { installed, desiredActivation: activated, pinnedArtifact, installedSpecifier: installedSpecifier ?? null, configHash: hash(config), packageName: details.packageName, mode: details.mode } }
  }

  async health(plan: ChangePlan, observation: TargetObservation): Promise<TargetHealth> {
    const value = object(observation.value, 'DSH observation')
    if (value.installed !== true || value.desiredActivation !== true || value.pinnedArtifact !== true) return { ok: false, reason: 'DSH package is not installed, selected, and pinned to the planned artifact', evidence: [] }
    const details = metadata(plan)
    return await activateAndCheck(this.instance, details.mode, details.healthPath)
  }

  async rollback(snapshot: TargetSnapshot, _executionId: ExecutionId): Promise<void> {
    const ref = object(snapshot.ref, 'DSH snapshot')
    if (typeof ref.snapshotPath !== 'string') throw new DeepSyncError('STATE_CORRUPT', 'Snapshot has no profile path')
    await restoreProfile(this.instance, ref.snapshotPath)
  }

  async verifyRollback(snapshot: TargetSnapshot): Promise<RollbackVerification> {
    const ref = object(snapshot.ref, 'DSH snapshot')
    if (typeof ref.dumpHash !== 'string' || typeof ref.profileDigest !== 'string') throw new DeepSyncError('STATE_CORRUPT', 'Snapshot has no verification digests')
    const restoredDumpHash = hash(await dump(this.instance))
    const restoredProfileDigest = await profileTreeDigest(profileDirectory(this.instance))
    const restored = restoredDumpHash === ref.dumpHash && restoredProfileDigest === ref.profileDigest
    const observedAt = new Date().toISOString()
    const evidence: Evidence[] = [
      { checkId: 'dsh.rollback-config', status: restoredDumpHash === ref.dumpHash ? 'pass' : 'fail', summary: restoredDumpHash === ref.dumpHash ? 'Restored config matches baseline' : 'Restored config differs from baseline', observedAt, data: { expected: ref.dumpHash, observed: restoredDumpHash } },
      { checkId: 'dsh.rollback-profile', status: restoredProfileDigest === ref.profileDigest ? 'pass' : 'fail', summary: restoredProfileDigest === ref.profileDigest ? 'Restored profile tree matches baseline' : 'Restored profile tree differs from baseline', observedAt, data: { expected: ref.profileDigest, observed: restoredProfileDigest } },
    ]
    if (restored) return { restored: true, evidence }
    return { restored: false, reason: 'Restored DSH profile differs from the durable baseline', evidence }
  }

  async disposeSnapshots(): Promise<void> {
    await rm(join(this.instance.home, '.deepsync-snapshots'), { recursive: true, force: true })
  }
}
