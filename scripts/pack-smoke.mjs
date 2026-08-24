import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const artifacts = resolve(root, 'artifacts')
const archives = (await readdir(artifacts)).filter(file => file.endsWith('.tgz')).map(file => resolve(artifacts, file))
if (archives.length !== 6) throw new Error('Run pack:all before pack:smoke')
const directory = await mkdtemp(join(tmpdir(), 'deepsync-pack-smoke-'))
function install(cwd) {
  if (process.platform === 'win32') return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm install'], { cwd, stdio: 'inherit', windowsHide: true })
  return spawnSync('pnpm', ['install'], { cwd, stdio: 'inherit' })
}

try {
  const archive = name => `file:${resolve(artifacts, name).replaceAll('\\', '/')}`
  const dependencies = {
    '@deepsync/contracts': archive('deepsync-contracts-0.1.0-alpha.1.tgz'),
    '@deepsync/core': archive('deepsync-core-0.1.0-alpha.1.tgz'),
    '@deepsync/doctor': archive('deepsync-doctor-0.1.0-alpha.1.tgz'),
    '@deepsync/source-github': archive('deepsync-source-github-0.1.0-alpha.1.tgz'),
    '@deepsync/target-dsh': archive('deepsync-target-dsh-0.1.0-alpha.1.tgz'),
    deepsync: archive('deepsync-0.1.0-alpha.1.tgz'),
  }
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'deepsync-pack-smoke', private: true, type: 'module', dependencies }, null, 2)}\n`)
  const yaml = ['packages:', '  - .', '', 'overrides:', ...Object.entries(dependencies).map(([name, specifier]) => `  '${name}': '${specifier}'`), ''].join('\n')
  await writeFile(join(directory, 'pnpm-workspace.yaml'), yaml)
  const installed = install(directory)
  if (installed.status !== 0) process.exit(installed.status ?? 1)
  await writeFile(join(directory, 'smoke.mjs'), "import { DeepSyncCore } from '@deepsync/core'; const core = new DeepSyncCore(); if (core.listAdapters().length !== 0) throw new Error('Core is not empty');\n")
  const smoke = spawnSync(process.execPath, ['smoke.mjs'], { cwd: directory, stdio: 'inherit', windowsHide: true })
  if (smoke.status !== 0) process.exit(smoke.status ?? 1)
  const cli = JSON.parse(await readFile(join(directory, 'node_modules', 'deepsync', 'package.json'), 'utf8'))
  const version = spawnSync(process.execPath, [join(directory, 'node_modules', 'deepsync', cli.bin.deepsync), '--version'], { cwd: directory, encoding: 'utf8', windowsHide: true })
  if (version.status !== 0 || version.stdout.trim() !== '0.1.0-alpha.1') throw new Error(`Packed CLI smoke failed: ${version.stderr || version.stdout}`)
  process.stdout.write('packed consumer smoke passed\n')
} finally {
  await rm(directory, { recursive: true, force: true })
}
