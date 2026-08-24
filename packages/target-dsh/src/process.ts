import { spawn } from 'node:child_process'

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

export function scrubEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /(?:KEY|TOKEN|SECRET|PASSWORD)/iu.test(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

export async function runCommand(command: DshCommand, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: command.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

export function sourceCheckoutCommand(root: string): DshCommand {
  return {
    command: process.execPath,
    prefixArgs: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'],
    cwd: root,
  }
}
