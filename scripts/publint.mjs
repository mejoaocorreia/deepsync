import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const packages = ['packages/contracts', 'packages/core', 'packages/doctor', 'packages/source-github', 'packages/target-dsh', 'apps/cli']
function runPnpm(args, cwd) {
  if (process.platform === 'win32') return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', ['pnpm', ...args].join(' ')], { cwd, stdio: 'inherit', windowsHide: true })
  return spawnSync('pnpm', args, { cwd, stdio: 'inherit' })
}

for (const directory of packages) {
  const result = runPnpm(['exec', 'publint'], resolve(root, directory))
  if (result.status !== 0) process.exit(result.status ?? 1)
}
