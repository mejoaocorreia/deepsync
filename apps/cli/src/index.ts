import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ChangeRequest, JsonValue, RequestId } from '@deepsync/contracts'
import { DeepSyncError, JsonFileStateStore, LifecycleManager, type PlannedChange } from '@deepsync/core'
import { evidenceCheck, nodeVersionCheck, readablePathCheck, runDoctor } from '@deepsync/doctor'
import {
  assertIsolated,
  createIsolatedDshInstance,
  detectDsh,
  DshTargetAdapter,
  openIsolatedDshInstance,
  sourceCheckoutCommand,
  targetInstanceId,
  type IsolatedDshInstance,
  type ProbeMode,
} from '@deepsync/target-dsh'

export const VERSION = '0.1.0-alpha.1'

interface ParsedArgs {
  readonly positional: readonly string[]
  readonly options: Readonly<Record<string, string | true>>
}

interface PlanDocument {
  readonly schemaVersion: 1
  readonly dshRoot: string
  readonly home: string
  readonly request: ChangeRequest
  readonly planned: PlannedChange
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
    if (name === 'json') {
      options[name] = true
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Option --${name} requires a value`)
    options[name] = value
    index += 1
  }
  return { positional, options }
}

function option(parsed: ParsedArgs, name: string, fallback?: string): string {
  const value = parsed.options[name] ?? fallback
  if (typeof value !== 'string' || value === '') throw new Error(`Missing required option --${name}`)
  return value
}

function statePath(parsed: ParsedArgs): string {
  return resolve(option(parsed, 'state', '.deepsync/state.json'))
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
  const target = create && !await exists(home)
    ? await createIsolatedDshInstance(command, home)
    : await openIsolatedDshInstance(command, home)
  await assertIsolated(target)
  return { dshRoot, instance: target }
}

function manager(target: IsolatedDshInstance, parsed: ParsedArgs): LifecycleManager {
  return new LifecycleManager({ adapters: [new DshTargetAdapter(target)], state: new JsonFileStateStore(statePath(parsed)) })
}

async function planAdd(parsed: ParsedArgs): Promise<JsonValue> {
  const sourcePath = parsed.positional[2]
  if (sourcePath === undefined) throw new Error('Usage: deepsync plan add <source> --dsh-root <path> --home <isolated-home>')
  const modeValue = option(parsed, 'mode', 'healthy')
  if (!['healthy', 'activation-failure', 'health-failure'].includes(modeValue)) throw new Error(`Unsupported probe mode ${modeValue}`)
  const mode = modeValue as ProbeMode
  const target = await instance(parsed, true)
  const request: ChangeRequest = {
    requestId: option(parsed, 'request-id', `request-${crypto.randomUUID()}`) as RequestId,
    targetInstanceId: targetInstanceId(target.instance.home),
    intent: { adapterId: 'dsh', action: 'add', sourcePath: resolve(sourcePath), mode },
  }
  const planned = await manager(target.instance, parsed).plan(request)
  const document: PlanDocument = { schemaVersion: 1, dshRoot: target.dshRoot, home: target.instance.home, request, planned }
  const filename = resolve(option(parsed, 'out', 'deepsync.plan.json'))
  await mkdir(dirname(filename), { recursive: true })
  await writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  return { command: 'plan add', plan: filename, requestId: request.requestId, planDigest: planned.planDigest, targetInstanceId: request.targetInstanceId }
}

async function readPlan(filename: string): Promise<PlanDocument> {
  const value = JSON.parse(await readFile(resolve(filename), 'utf8')) as Partial<PlanDocument>
  if (value.schemaVersion !== 1 || value.request === undefined || value.planned === undefined || typeof value.dshRoot !== 'string' || typeof value.home !== 'string') {
    throw new Error('Plan document is malformed or unsupported')
  }
  return value as PlanDocument
}

async function applyPlan(parsed: ParsedArgs): Promise<JsonValue> {
  const filename = parsed.positional[1]
  if (filename === undefined) throw new Error('Usage: deepsync apply <plan-file> [--state <path>]')
  const document = await readPlan(filename)
  const target = await openIsolatedDshInstance(sourceCheckoutCommand(document.dshRoot), document.home)
  return await manager(target, parsed).execute(document.request, document.planned) as unknown as JsonValue
}

async function rollback(parsed: ParsedArgs): Promise<JsonValue> {
  const requestId = parsed.positional[1]
  if (requestId === undefined) throw new Error('Usage: deepsync rollback <request-id> --dsh-root <path> --home <isolated-home>')
  const target = await instance(parsed, false)
  return await manager(target.instance, parsed).rollback(requestId) as unknown as JsonValue
}

async function status(parsed: ParsedArgs): Promise<JsonValue> {
  const state = await new JsonFileStateStore(statePath(parsed)).load()
  return {
    schemaVersion: 1,
    transactions: Object.values(state.transactions).map(record => ({
      requestId: record.requestId,
      planDigest: record.planDigest,
      phase: record.phase,
      installation: record.phase === 'quarantined' && record.restored === true ? 'absent' : ['applied', 'observed', 'healthy', 'committed'].includes(record.phase) ? 'installed' : record.phase === 'planned' || record.phase === 'validated' || record.phase === 'snapshotted' ? 'staged' : 'unknown',
      desiredActivation: 'active',
      observedActivation: record.phase === 'committed' ? 'active' : record.phase === 'quarantined' && record.restored === true ? 'inactive' : record.phase === 'quarantined' || record.phase === 'rejected' ? 'failed' : 'unknown',
      health: record.phase === 'committed' ? 'healthy' : 'unknown',
      trust: 'unknown',
      update: 'unknown',
      restored: record.restored ?? null,
    })),
    quarantined: Object.values(state.quarantined),
    lastKnownGoodTargets: Object.keys(state.lastKnownGood),
  } as unknown as JsonValue
}

async function doctor(parsed: ParsedArgs): Promise<JsonValue> {
  const target = await instance(parsed, false)
  const detected = await detectDsh(target.instance)
  const report = await runDoctor([
    nodeVersionCheck(22),
    readablePathCheck('deepsync.cwd', process.cwd()),
    ...detected.evidence.map(evidenceCheck),
  ])
  return { ...report, target: detected.target } as unknown as JsonValue
}

export function help(): string {
  return `DeepSync ${VERSION}\n\nCommands:\n  status [--state <path>] [--json]\n  doctor --dsh-root <path> --home <isolated-home> [--json]\n  plan add <source> --dsh-root <path> --home <isolated-home> [--mode healthy|activation-failure|health-failure] [--out <file>]\n  apply <plan-file> [--state <path>] [--json]\n  rollback <request-id> --dsh-root <path> --home <isolated-home> [--state <path>] [--json]\n`
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help())
    return 0
  }
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  const parsed = parseArgs(args)
  const json = parsed.options.json === true
  try {
    const [command, subcommand] = parsed.positional
    let result: JsonValue
    if (command === 'status') result = await status(parsed)
    else if (command === 'doctor') result = await doctor(parsed)
    else if (command === 'plan' && subcommand === 'add') result = await planAdd(parsed)
    else if (command === 'apply') result = await applyPlan(parsed)
    else if (command === 'rollback') result = await rollback(parsed)
    else throw new Error(`Unknown command: ${parsed.positional.join(' ')}`)
    output(result, json)
    return 0
  } catch (error) {
    const payload: JsonValue = {
      error: error instanceof DeepSyncError ? error.code : 'COMMAND_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }
    if (json) process.stderr.write(`${JSON.stringify(payload)}\n`)
    else process.stderr.write(`deepsync: ${(payload as Readonly<Record<string, JsonValue>>).message}\n`)
    return 1
  }
}
