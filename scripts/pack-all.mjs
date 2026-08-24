import { mkdir, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts')
const packages = [
  'packages/contracts',
  'packages/core',
  'packages/doctor',
  'packages/source-github',
  'packages/target-dsh',
  'apps/cli',
]

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
function runPack(cwd) {
  if (process.platform === 'win32') return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm pack --pack-destination ..\\..\\artifacts'], { cwd, stdio: 'inherit', windowsHide: true })
  return spawnSync('pnpm', ['pack', '--pack-destination', output], { cwd, stdio: 'inherit' })
}

for (const directory of packages) {
  const result = runPack(resolve(root, directory))
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const archives = (await readdir(output)).filter(file => file.endsWith('.tgz')).sort()
if (archives.length !== packages.length) throw new Error(`Expected ${packages.length} archives, found ${archives.length}`)
process.stdout.write(`${archives.join('\n')}\n`)
