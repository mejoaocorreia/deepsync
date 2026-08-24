import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ArtifactDigest, ArtifactSourceReferenceV1, ChangeRequest, JsonValue, RequestId } from '@deepsync/contracts'
import { DeepSyncError, FileRunLock, JsonFileStateStore, LifecycleManager, type ExecutionResult, type PlannedChange } from '@deepsync/core'
import { evidenceCheck, nodeVersionCheck, readablePathCheck, runDoctor, validatePluginInput } from '@deepsync/doctor'
import {
  assertIsolated,
  createIsolatedDshInstance,
  detectDsh,
  DshTargetAdapter,
  openIsolatedDshInstance,
  sourceCheckoutCommand,
  targetInstanceId,
  type IsolatedDshInstance,
} from '@deepsync/target-dsh'
import { resolvePluginArtifact } from './artifacts.ts'

export * from './artifacts.ts'

export const VERSION = '0.1.0-alpha.3'
export const EXIT_CODES = {
  success: 0,
  failure: 1,
  usage: 2,
  doctorUnhealthy: 10,
  pluginInvalid: 12,
  applyRejected: 20,
  applyQuarantined: 21,
  rollbackUnverified: 22,
} as const

class CliUsageError extends Error {
  readonly code = 'USAGE'
}

interface ParsedArgs {
  readonly positional: readonly string[]
  readonly options: Readonly<Record<string, string | true>>
}

interface PlanDocument {
  readonly schemaVersion: 3
  readonly source: ArtifactSourceReferenceV1
  readonly dshRoot: string
  readonly home: string
  readonly instanceNonce: string
  readonly statePath: string
  readonly request: ChangeRequest
  readonly planned: PlannedChange
}

interface CommandOutcome {
  readonly value: JsonValue
  readonly exitCode: number
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const options: Record<string, string | true> = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (name === '' || options[name] !== undefined) throw new CliUsageError(`Invalid or duplicate option --${name}`)
    if (name === 'json') {
      options[name] = true
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new CliUsageError(`Option --${name} requires a value`)
    options[name] = value
    index += 1
  }
  return { positional, options }
}

function allowOptions(parsed: ParsedArgs, allowed: readonly string[]): void {
  const accepted = new Set(['json', ...allowed])
  const unknown = Object.keys(parsed.options).find(name => !accepted.has(name))
  if (unknown !== undefined) throw new CliUsageError(`Unknown option --${unknown}`)
}

function option(parsed: ParsedArgs, name: string, fallback?: string): string {
  const value = parsed.options[name] ?? fallback
  if (typeof value !== 'string' || value === '') throw new CliUsageError(`Missing required option --${name}`)
  return value
}

function output(value: JsonValue, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else if (typeof value === 'string') process.stdout.write(`${value}\n`)
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function instance(parsed: ParsedArgs, create: boolean): Promise<{ readonly dshRoot: string; readonly instance: IsolatedDshInstance }> {
  const dshRoot = resolve(option(parsed, 'dsh-root', process.env.DSH_CHECKOUT))
  const home = resolve(option(parsed, 'home'))
  const command = sourceCheckoutCommand(dshRoot)
  const target = create && !await exists(home) ? await createIsolatedDshInstance(command, home) : await openIsolatedDshInstance(command, home)
  await assertIsolated(target)
  return { dshRoot, instance: target }
}

function manager(target: IsolatedDshInstance, filename: string): LifecycleManager {
  return new LifecycleManager({
    adapters: [new DshTargetAdapter(target)],
    state: new JsonFileStateStore(filename),
    lock: new FileRunLock(`${filename}.lock`),
  })
}

async function assertStateTarget(lifecycle: LifecycleManager, target: IsolatedDshInstance): Promise<void> {
  const expected = targetInstanceId(target)
  const mismatched = Object.values((await lifecycle.state()).transactions).find(record => record.targetInstanceId !== expected)
  if (mismatched !== undefined) throw new DeepSyncError('TARGET_MISMATCH', `State file contains target ${mismatched.targetInstanceId}, expected ${expected}`)
}

function planSource(parsed: ParsedArgs): ArtifactSourceReferenceV1 {
  const sourcePath = parsed.positional[2]
  const github = parsed.options.github
  if (sourcePath !== undefined && github !== undefined) throw new CliUsageError('Choose either a local source path or --github, never both')
  if (sourcePath !== undefined) {
    if (parsed.positional.length !== 3) throw new CliUsageError('Usage: deepsync plan add <source> --dsh-root <path> --home <isolated-home>')
    if (parsed.options.tag !== undefined || parsed.options.asset !== undefined || parsed.options.digest !== undefined) throw new CliUsageError('--tag, --asset, and --digest require --github')
    return { schemaVersion: 1, kind: 'local-package', path: resolve(sourcePath) }
  }
  if (parsed.positional.length !== 2 || typeof github !== 'string') throw new CliUsageError('Usage: deepsync plan add --github <owner/repository> --tag <tag> --asset <file.tgz> --digest <sha256:digest> --dsh-root <path> --home <isolated-home>')
  const segments = github.split('/')
  if (segments.length !== 2 || segments.some(segment => segment === '')) throw new CliUsageError('--github must be owner/repository')
  const digest = option(parsed, 'digest')
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new CliUsageError('--digest must be a complete lowercase sha256:<64-hex> value')
  return {
    schemaVersion: 1,
    kind: 'github-release',
    owner: segments[0]!,
    repository: segments[1]!,
    tag: option(parsed, 'tag'),
    asset: option(parsed, 'asset'),
    digest: digest as ArtifactDigest,
  }
}

async function planAdd(parsed: ParsedArgs): Promise<CommandOutcome> {
  allowOptions(parsed, ['dsh-root', 'home', 'out', 'state', 'request-id', 'artifact-cache', 'github', 'tag', 'asset', 'digest'])
  const source = planSource(parsed)
  const resolvedArtifact = await resolvePluginArtifact(source, option(parsed, 'artifact-cache', '.deepsync/artifacts'))
  const artifact = resolvedArtifact.artifact
  const target = await instance(parsed, true)
  const filename = resolve(option(parsed, 'state', join(target.instance.home, '.deepsync', 'state.json')))
  const request: ChangeRequest = {
    requestId: option(parsed, 'request-id', `request-${crypto.randomUUID()}`) as RequestId,
    targetInstanceId: targetInstanceId(target.instance),
    intent: { schemaVersion: 1, adapterId: 'dsh', action: 'add', artifact: { schemaVersion: 1, kind: 'packed-artifact', path: artifact.artifactPath, digest: artifact.artifactDigest } },
  }
  const planned = await manager(target.instance, filename).plan(request)
  const document: PlanDocument = { schemaVersion: 3, source: resolvedArtifact.source, dshRoot: target.dshRoot, home: target.instance.home, instanceNonce: target.instance.instanceNonce, statePath: filename, request, planned }
  const planFilename = resolve(option(parsed, 'out', 'deepsync.plan.json'))
  await mkdir(dirname(planFilename), { recursive: true })
  await writeFile(planFilename, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  return { value: { command: 'plan add', source: resolvedArtifact.source, sourceEvidence: resolvedArtifact.evidence, plan: planFilename, state: filename, requestId: request.requestId, artifactDigest: artifact.artifactDigest, planDigest: planned.planDigest, targetInstanceId: request.targetInstanceId } as unknown as JsonValue, exitCode: EXIT_CODES.success }
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CliUsageError(`${subject} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], subject: string): void {
  const expectedKeys = new Set(expected)
  const unknown = Object.keys(value).find(key => !expectedKeys.has(key))
  const missing = expected.find(key => !(key in value))
  if (unknown !== undefined || missing !== undefined) throw new CliUsageError(`${subject} has ${unknown === undefined ? `no ${missing}` : `unknown field ${unknown}`}`)
}

async function readPlan(filename: string): Promise<PlanDocument> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(resolve(filename), 'utf8'))
  } catch (error) {
    throw new CliUsageError(`Cannot read plan document: ${error instanceof Error ? error.message : String(error)}`)
  }
  const candidate = record(value, 'Plan document')
  exactKeys(candidate, ['schemaVersion', 'source', 'dshRoot', 'home', 'instanceNonce', 'statePath', 'request', 'planned'], 'Plan document')
  if (candidate.schemaVersion !== 3 || typeof candidate.dshRoot !== 'string' || typeof candidate.home !== 'string'
    || typeof candidate.instanceNonce !== 'string' || typeof candidate.statePath !== 'string') throw new CliUsageError('Plan document is malformed or unsupported')
  const source = record(candidate.source, 'Plan source')
  if (source.schemaVersion !== 1 || !['local-package', 'github-release'].includes(typeof source.kind === 'string' ? source.kind : '')) throw new CliUsageError('Plan source is malformed or unsupported')
  if (source.kind === 'local-package') {
    exactKeys(source, ['schemaVersion', 'kind', 'path'], 'Plan local source')
    if (typeof source.path !== 'string') throw new CliUsageError('Plan local source path is malformed')
  } else {
    exactKeys(source, ['schemaVersion', 'kind', 'owner', 'repository', 'tag', 'asset', 'digest'], 'Plan GitHub source')
    if (typeof source.owner !== 'string' || typeof source.repository !== 'string' || typeof source.tag !== 'string' || typeof source.asset !== 'string' || typeof source.digest !== 'string') throw new CliUsageError('Plan GitHub source is malformed')
  }
  const request = record(candidate.request, 'Plan request')
  exactKeys(request, ['requestId', 'targetInstanceId', 'intent'], 'Plan request')
  if (typeof request.requestId !== 'string' || typeof request.targetInstanceId !== 'string') throw new CliUsageError('Plan request identity is malformed')
  const planned = record(candidate.planned, 'Planned change')
  exactKeys(planned, ['request', 'requestFingerprint', 'plan', 'planDigest'], 'Planned change')
  if (typeof planned.requestFingerprint !== 'string' || typeof planned.planDigest !== 'string') throw new CliUsageError('Planned change identity is malformed')
  exactKeys(record(planned.request, 'Planned request'), ['requestId', 'targetInstanceId', 'intent'], 'Planned request')
  const plan = record(planned.plan, 'Change plan')
  exactKeys(plan, ['schemaVersion', 'adapterId', 'targetInstanceId', 'artifactDigest', 'operations', 'metadata'], 'Change plan')
  if (plan.schemaVersion !== 1 || typeof plan.adapterId !== 'string' || typeof plan.targetInstanceId !== 'string'
    || typeof plan.artifactDigest !== 'string' || !Array.isArray(plan.operations)) throw new CliUsageError('Change plan is malformed')
  return candidate as unknown as PlanDocument
}

export function executionExitCode(result: ExecutionResult): number {
  if (result.status === 'committed') return EXIT_CODES.success
  if (result.status === 'rejected') return EXIT_CODES.applyRejected
  return EXIT_CODES.applyQuarantined
}

async function applyPlan(parsed: ParsedArgs): Promise<CommandOutcome> {
  allowOptions(parsed, ['state'])
  const filename = parsed.positional[1]
  if (filename === undefined || parsed.positional.length !== 2) throw new CliUsageError('Usage: deepsync apply <plan-file> [--state <path>]')
  const document = await readPlan(filename)
  const target = await openIsolatedDshInstance(sourceCheckoutCommand(document.dshRoot), document.home)
  if (target.instanceNonce !== document.instanceNonce) throw new DeepSyncError('TARGET_MISMATCH', 'Plan isolation nonce does not match the target home')
  const stateFilename = resolve(option(parsed, 'state', document.statePath))
  const lifecycle = manager(target, stateFilename)
  await assertStateTarget(lifecycle, target)
  await lifecycle.recover()
  const result = await lifecycle.execute(document.request, document.planned)
  return { value: result as unknown as JsonValue, exitCode: executionExitCode(result) }
}

async function rollback(parsed: ParsedArgs): Promise<CommandOutcome> {
  allowOptions(parsed, ['dsh-root', 'home', 'state'])
  const requestId = parsed.positional[1]
  if (requestId === undefined || parsed.positional.length !== 2) throw new CliUsageError('Usage: deepsync rollback <request-id> --dsh-root <path> --home <isolated-home>')
  const target = await instance(parsed, false)
  const stateFilename = resolve(option(parsed, 'state', join(target.instance.home, '.deepsync', 'state.json')))
  const lifecycle = manager(target.instance, stateFilename)
  await assertStateTarget(lifecycle, target.instance)
  await lifecycle.recover()
  const result = await lifecycle.rollback(requestId)
  return { value: result as unknown as JsonValue, exitCode: result.status === 'quarantined' && result.restored ? EXIT_CODES.success : EXIT_CODES.rollbackUnverified }
}

async function recover(parsed: ParsedArgs): Promise<CommandOutcome> {
  allowOptions(parsed, ['dsh-root', 'home', 'state'])
  if (parsed.positional.length !== 1) throw new CliUsageError('Usage: deepsync recover --dsh-root <path> --home <isolated-home>')
  const target = await instance(parsed, false)
  const stateFilename = resolve(option(parsed, 'state', join(target.instance.home, '.deepsync', 'state.json')))
  const lifecycle = manager(target.instance, stateFilename)
  await assertStateTarget(lifecycle, target.instance)
  const recovered = await lifecycle.recover()
  return { value: { recovered: recovered.map(item => ({ requestId: item.requestId, phase: item.phase, restored: item.restored ?? null })) }, exitCode: EXIT_CODES.success }
}

async function status(parsed: ParsedArgs): Promise<CommandOutcome> {
  allowOptions(parsed, ['state'])
  if (parsed.positional.length !== 1) throw new CliUsageError('Usage: deepsync status [--state <path>]')
  const filename = resolve(option(parsed, 'state', '.deepsync/state.json'))
  const state = await new JsonFileStateStore(filename).load()
  return {
    value: {
      schemaVersion: 1,
      state: filename,
      transactions: Object.values(state.transactions).map(item => ({
        requestId: item.requestId,
        artifactDigest: item.artifactDigest,
        planDigest: item.planDigest,
        phase: item.phase,
        currentHead: state.targetHeads[item.targetInstanceId] === item.requestId,
        installation: item.phase === 'quarantined' && item.restored === true ? 'baseline-restored' : ['applied', 'observed', 'healthy', 'committed'].includes(item.phase) ? 'installed' : item.phase === 'planned' || item.phase === 'validated' || item.phase === 'snapshotted' ? 'staged' : 'unknown',
        desiredActivation: 'active',
        observedActivation: item.phase === 'committed' ? 'active' : item.phase === 'quarantined' && item.restored === true ? 'baseline' : item.phase === 'quarantined' || item.phase === 'rejected' ? 'failed' : 'unknown',
        health: item.phase === 'committed' ? 'healthy' : 'unknown',
        trust: 'unknown',
        update: 'unknown',
        restored: item.restored ?? null,
      })),
      quarantined: Object.values(state.quarantined),
      lastKnownGoodTargets: Object.keys(state.lastKnownGood),
      targetHeads: state.targetHeads,
    } as unknown as JsonValue,
    exitCode: EXIT_CODES.success,
  }
}

async function dshDoctor(parsed: ParsedArgs): Promise<CommandOutcome> {
  allowOptions(parsed, ['dsh-root', 'home', 'state'])
  if (parsed.positional.length !== 1) throw new CliUsageError('Usage: deepsync doctor --dsh-root <path> --home <isolated-home>')
  const target = await instance(parsed, false)
  const detected = await detectDsh(target.instance)
  const report = await runDoctor([
    nodeVersionCheck(),
    readablePathCheck('deepsync.cwd', process.cwd()),
    readablePathCheck('deepsync.dsh-checkout', target.dshRoot),
    ...detected.evidence.map(evidenceCheck),
  ])
  return { value: { ...report, target: detected.target } as unknown as JsonValue, exitCode: report.healthy ? EXIT_CODES.success : EXIT_CODES.doctorUnhealthy }
}

async function pluginValidation(parsed: ParsedArgs, asDoctor: boolean): Promise<CommandOutcome> {
  allowOptions(parsed, [])
  const input = parsed.positional[2]
  if (input === undefined || parsed.positional.length !== 3) {
    throw new CliUsageError(`Usage: deepsync ${asDoctor ? 'doctor plugin' : 'plugin validate'} <path|artifact>`)
  }
  const report = await validatePluginInput(input)
  return {
    value: { command: asDoctor ? 'doctor plugin' : 'plugin validate', ...report } as unknown as JsonValue,
    exitCode: report.valid ? EXIT_CODES.success : asDoctor ? EXIT_CODES.doctorUnhealthy : EXIT_CODES.pluginInvalid,
  }
}

export function help(): string {
  return `DeepSync ${VERSION}\n\nCommands:\n  status [--state <path>] [--json]\n  doctor --dsh-root <path> --home <isolated-home> [--json]\n  doctor plugin <path|artifact> [--json]\n  plugin validate <path|artifact> [--json]\n  plan add <source> --dsh-root <path> --home <isolated-home> [--out <file>]\n  plan add --github <owner/repository> --tag <tag> --asset <file.tgz> --digest <sha256:digest> --dsh-root <path> --home <isolated-home> [--out <file>]\n  apply <plan-file> [--state <path>] [--json]\n  rollback <request-id> --dsh-root <path> --home <isolated-home> [--state <path>] [--json]\n  recover --dsh-root <path> --home <isolated-home> [--state <path>] [--json]\n`
}

export async function main(args: readonly string[]): Promise<number> {
  const jsonRequested = args.includes('--json')
  try {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      process.stdout.write(help())
      return EXIT_CODES.success
    }
    if (args.includes('--version') || args.includes('-V')) {
      process.stdout.write(`${VERSION}\n`)
      return EXIT_CODES.success
    }
    const parsed = parseArgs(args)
    const [command, subcommand] = parsed.positional
    let outcome: CommandOutcome
    if (command === 'status') outcome = await status(parsed)
    else if (command === 'doctor' && subcommand === 'plugin') outcome = await pluginValidation(parsed, true)
    else if (command === 'doctor') outcome = await dshDoctor(parsed)
    else if (command === 'plugin' && subcommand === 'validate') outcome = await pluginValidation(parsed, false)
    else if (command === 'plan' && subcommand === 'add') outcome = await planAdd(parsed)
    else if (command === 'apply') outcome = await applyPlan(parsed)
    else if (command === 'rollback') outcome = await rollback(parsed)
    else if (command === 'recover') outcome = await recover(parsed)
    else throw new CliUsageError(`Unknown command: ${parsed.positional.join(' ')}`)
    output(outcome.value, parsed.options.json === true)
    return outcome.exitCode
  } catch (error) {
    const exitCode = error instanceof CliUsageError ? EXIT_CODES.usage : EXIT_CODES.failure
    const payload: JsonValue = { error: error instanceof DeepSyncError ? error.code : error instanceof CliUsageError ? error.code : 'COMMAND_FAILED', message: error instanceof Error ? error.message : String(error), exitCode }
    if (jsonRequested) process.stderr.write(`${JSON.stringify(payload)}\n`)
    else process.stderr.write(`deepsync: ${(payload as Readonly<Record<string, JsonValue>>).message}\n`)
    return exitCode
  }
}
