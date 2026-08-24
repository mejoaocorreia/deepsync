import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Evidence, TargetHealth } from '@deepsync/contracts'
import type { IsolatedDshInstance } from './isolated.ts'
import { scrubEnvironment } from './process.ts'

export type ProbeMode = 'healthy' | 'activation-failure' | 'health-failure'

async function waitForProbe(filename: string, childClosed: Promise<number | null>, timeoutMs: number): Promise<{ healthy?: boolean; mode?: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filename, 'utf8')) as { healthy?: boolean; mode?: string }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const outcome = await Promise.race([
      childClosed.then(code => ({ kind: 'closed' as const, code })),
      new Promise<{ kind: 'tick' }>(resolve => setTimeout(() => resolve({ kind: 'tick' }), 50)),
    ])
    if (outcome.kind === 'closed') throw new Error(`DSH exited before fixture health evidence with code ${outcome.code}`)
  }
  throw new Error(`DSH fixture activation timed out after ${timeoutMs}ms`)
}

export async function activateAndCheck(instance: IsolatedDshInstance, mode: ProbeMode, timeoutMs = 15_000): Promise<TargetHealth> {
  const observedAt = new Date().toISOString()
  const filename = join(instance.home, 'deepsync-probe-health.json')
  await rm(filename, { force: true })
  const child = spawn(instance.command.command, [...instance.command.prefixArgs, '--profile', instance.profile], {
    cwd: instance.command.cwd,
    env: scrubEnvironment({ DSH_HOME: instance.home, DEEPSYNC_PROBE_MODE: mode }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let errorOutput = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { errorOutput += chunk })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve)
    child.once('error', reject)
  })
  try {
    const probe = await waitForProbe(filename, closed, timeoutMs)
    const evidence: Evidence[] = [
      { checkId: 'dsh.loader-activation', status: 'pass', summary: 'DSH Loader executed the lifecycle probe', observedAt },
      { checkId: 'fixture.health', status: probe.healthy === true ? 'pass' : 'fail', summary: `Fixture reported ${probe.mode ?? 'unknown'}`, observedAt, data: probe as never },
    ]
    if (probe.healthy !== true) return { ok: false, reason: 'DSH staged health check failed', evidence }
    return { ok: true, evidence }
  } catch (error) {
    const detail = [error instanceof Error ? error.message : String(error), errorOutput.trim(), output.trim()].filter(Boolean).join(': ')
    return {
      ok: false,
      reason: detail,
      evidence: [{ checkId: 'dsh.loader-activation', status: 'fail', summary: detail, observedAt }],
    }
  } finally {
    child.kill()
    await Promise.race([closed.then(() => undefined), new Promise<void>(resolve => setTimeout(resolve, 5_000))])
  }
}
