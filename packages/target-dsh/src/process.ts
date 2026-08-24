import { spawn, type ChildProcess } from 'node:child_process'

export interface DshCommand {
  readonly command: string
  readonly prefixArgs: readonly string[]
  readonly cwd?: string
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const ALLOWED_ENVIRONMENT = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'TERM', 'NO_COLOR', 'CI',
])

export function scrubEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ALLOWED_ENVIRONMENT.has(key.toUpperCase())) env[key] = value
  }
  return { ...env, ...extra }
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => resolve())
      killer.once('close', () => resolve())
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  await Promise.race([
    new Promise<void>(resolve => child.once('close', () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, 2_000)),
  ])
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

export async function runCommand(command: DshCommand, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: command.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const fail = async (error: Error): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      await terminateProcessTree(child)
      reject(error)
    }
    const timer = setTimeout(() => { void fail(new Error(`Command timed out after ${timeoutMs}ms`)) }, timeoutMs)
    const append = (target: 'stdout' | 'stderr', chunk: string): void => {
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
      if (stdout.length + stderr.length > 4 * 1024 * 1024) void fail(new Error('Command output exceeded 4 MiB'))
    }
    child.stdout.setEncoding('utf8').on('data', chunk => append('stdout', chunk))
    child.stderr.setEncoding('utf8').on('data', chunk => append('stderr', chunk))
    child.once('error', error => { void fail(error) })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

export function sourceCheckoutCommand(root: string): DshCommand {
  return { command: process.execPath, prefixArgs: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'], cwd: root }
}
