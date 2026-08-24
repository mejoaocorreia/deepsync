import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  DSH_HEALTH_ENV_V1,
  DSH_HEALTH_PROTOCOL_V1,
  validateDshHealthResultDocument,
  type ActivationAttemptId,
  type DshHealthDeclarationV1,
  type Evidence,
  type JsonValue,
  type PluginId,
  type TargetHealth,
  type TargetInstanceId,
} from '@deepsync/contracts'
import { isolatedEnvironment, type IsolatedDshInstance } from './isolated.ts'
import { terminateProcessTree } from './process.ts'

export interface DshHealthExpectationV1 {
  readonly pluginId: PluginId
  readonly pluginVersion: string
  readonly targetInstanceId: TargetInstanceId
  readonly activationAttemptId: ActivationAttemptId
  readonly declaration: DshHealthDeclarationV1
}

async function waitForHealthFile(filename: string, childClosed: Promise<number | null>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const outcome = await Promise.race([
      childClosed.then(code => ({ kind: 'closed' as const, code })),
      new Promise<{ kind: 'tick' }>(resolveTick => setTimeout(() => resolveTick({ kind: 'tick' }), 50)),
    ])
    if (outcome.kind === 'closed') throw new Error(`DSH exited before the plugin emitted health evidence with code ${outcome.code}`)
  }
  throw new Error(`DSH plugin activation timed out after ${timeoutMs}ms`)
}

function correlationFailure(expectation: DshHealthExpectationV1, value: {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly targetInstanceId: string
  readonly activationAttemptId: string
}): string | undefined {
  if (value.pluginId !== expectation.pluginId) return 'pluginId does not identify the planned plugin'
  if (value.pluginVersion !== expectation.pluginVersion) return 'pluginVersion does not identify the planned artifact version'
  if (value.targetInstanceId !== expectation.targetInstanceId) return 'targetInstanceId does not identify the isolated target'
  if (value.activationAttemptId !== expectation.activationAttemptId) return 'activationAttemptId does not identify the planned activation'
  return undefined
}

export async function activateAndCheck(instance: IsolatedDshInstance, expectation: DshHealthExpectationV1, timeoutMs = 15_000): Promise<TargetHealth> {
  const activationStartedAt = Date.now()
  const observedAt = new Date(activationStartedAt).toISOString()
  const filename = resolve(instance.home, expectation.declaration.path)
  const confined = relative(instance.home, filename)
  if (confined.startsWith('..') || isAbsolute(confined)) return { ok: false, reason: 'Declared health evidence path escapes the isolated home', evidence: [] }
  await rm(filename, { force: true })
  const child = spawn(instance.command.command, [...instance.command.prefixArgs, '--profile', instance.profile], {
    cwd: instance.command.cwd,
    env: {
      ...isolatedEnvironment(instance),
      [DSH_HEALTH_ENV_V1.protocol]: DSH_HEALTH_PROTOCOL_V1,
      [DSH_HEALTH_ENV_V1.resultPath]: filename,
      [DSH_HEALTH_ENV_V1.pluginId]: expectation.pluginId,
      [DSH_HEALTH_ENV_V1.pluginVersion]: expectation.pluginVersion,
      [DSH_HEALTH_ENV_V1.targetInstanceId]: expectation.targetInstanceId,
      [DSH_HEALTH_ENV_V1.activationAttemptId]: expectation.activationAttemptId,
    },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let errorOutput = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  child.stderr.setEncoding('utf8').on('data', chunk => { errorOutput = `${errorOutput}${String(chunk)}`.slice(-16_384) })
  const closed = new Promise<number | null>((resolveClosed, reject) => {
    child.once('close', resolveClosed)
    child.once('error', reject)
  })
  try {
    const text = await waitForHealthFile(filename, closed, timeoutMs)
    const loaderEvidence: Evidence = {
      checkId: 'dsh.loader-observation',
      status: 'pass',
      summary: 'The selected plugin emitted evidence during DSH Loader activation',
      observedAt,
      data: { activationAttemptId: expectation.activationAttemptId },
    }
    let input: unknown
    try {
      input = JSON.parse(text)
    } catch (error) {
      const reason = `Plugin health result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      return { ok: false, reason, evidence: [loaderEvidence, { checkId: 'plugin.health.v1', status: 'fail', summary: reason, observedAt }] }
    }
    const validated = validateDshHealthResultDocument(input)
    if (!validated.valid) {
      const reason = 'Plugin health result does not conform to deepsync.health/v1'
      const issues: JsonValue = validated.issues.map(issue => ({ code: issue.code, path: issue.path, message: issue.message, remediation: issue.remediation }))
      return { ok: false, reason, evidence: [loaderEvidence, { checkId: 'plugin.health.v1', status: 'fail', summary: reason, observedAt, data: { issues } }] }
    }
    const mismatch = correlationFailure(expectation, validated.value)
    if (mismatch !== undefined) {
      const reason = `Plugin health correlation failed: ${mismatch}`
      return { ok: false, reason, evidence: [loaderEvidence, { checkId: 'plugin.health.v1', status: 'fail', summary: reason, observedAt, data: { code: 'HEALTH_CORRELATION_MISMATCH' } }] }
    }
    const resultTime = Date.parse(validated.value.observedAt)
    if (!Number.isFinite(resultTime) || resultTime < activationStartedAt - 5_000 || resultTime > Date.now() + 300_000) {
      const reason = 'Plugin health result has a stale or invalid observedAt timestamp'
      return { ok: false, reason, evidence: [loaderEvidence, { checkId: 'plugin.health.v1', status: 'fail', summary: reason, observedAt, data: { code: 'HEALTH_RESULT_STALE' } }] }
    }
    const healthEvidence: Evidence = {
      checkId: 'plugin.health.v1',
      status: validated.value.status === 'healthy' ? 'pass' : 'fail',
      summary: validated.value.summary ?? `Plugin reported ${validated.value.status}`,
      observedAt,
      data: {
        schemaVersion: validated.value.schemaVersion,
        protocol: validated.value.protocol,
        pluginId: validated.value.pluginId,
        pluginVersion: validated.value.pluginVersion,
        targetInstanceId: validated.value.targetInstanceId,
        activationAttemptId: validated.value.activationAttemptId,
        status: validated.value.status,
        observedAt: validated.value.observedAt,
        ...(validated.value.summary === undefined ? {} : { summary: validated.value.summary }),
        ...(validated.value.data === undefined ? {} : { data: validated.value.data }),
      },
    }
    if (validated.value.status === 'unhealthy') return { ok: false, reason: healthEvidence.summary, evidence: [loaderEvidence, healthEvidence] }
    return { ok: true, evidence: [loaderEvidence, healthEvidence] }
  } catch (error) {
    const detail = [error instanceof Error ? error.message : String(error), errorOutput.trim(), output.trim()].filter(Boolean).join(': ')
    return {
      ok: false,
      reason: detail,
      evidence: [
        { checkId: 'dsh.loader-observation', status: 'fail', summary: detail, observedAt },
        { checkId: 'plugin.health.v1', status: 'skip', summary: 'No correlated plugin health result was available', observedAt },
      ],
    }
  } finally {
    await terminateProcessTree(child)
    await Promise.race([closed.then(() => undefined), new Promise<void>(resolveWait => setTimeout(resolveWait, 5_000))])
  }
}
