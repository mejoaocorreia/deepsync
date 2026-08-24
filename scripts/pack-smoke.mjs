import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const artifacts = resolve(root, 'artifacts')
const packageDirectories = [
  'packages/contracts',
  'packages/core',
  'packages/doctor',
  'packages/source-github',
  'packages/target-dsh',
  'apps/cli',
]
const manifests = await Promise.all(packageDirectories.map(async directory => JSON.parse(await readFile(resolve(root, directory, 'package.json'), 'utf8'))))
const archiveName = manifest => `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`
const expectedArchives = manifests.map(archiveName).sort()
const actualArchives = (await readdir(artifacts)).filter(file => file.endsWith('.tgz')).sort()
if (JSON.stringify(actualArchives) !== JSON.stringify(expectedArchives)) throw new Error(`Packed archive set differs: expected ${expectedArchives.join(', ')}, found ${actualArchives.join(', ')}`)
const directory = await mkdtemp(join(tmpdir(), 'deepsync-pack-smoke-'))

function install(cwd) {
  const arguments_ = ['install', '--offline', '--ignore-scripts']
  if (process.platform === 'win32') return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `pnpm ${arguments_.join(' ')}`], { cwd, stdio: 'inherit', windowsHide: true })
  return spawnSync('pnpm', arguments_, { cwd, stdio: 'inherit' })
}

try {
  const archive = manifest => `file:${resolve(artifacts, archiveName(manifest)).replaceAll('\\', '/')}`
  const dependencies = Object.fromEntries(manifests.map(manifest => [manifest.name, archive(manifest)]))
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'deepsync-pack-smoke', private: true, type: 'module', dependencies }, null, 2)}\n`)
  const yaml = ['packages:', '  - .', '', 'overrides:', ...Object.entries(dependencies).map(([name, specifier]) => `  '${name}': '${specifier}'`), ''].join('\n')
  await writeFile(join(directory, 'pnpm-workspace.yaml'), yaml)
  const installed = install(directory)
  if (installed.status !== 0) process.exit(installed.status ?? 1)
  await writeFile(join(directory, 'smoke.mjs'), [
    "import * as contracts from '@deepsync/contracts'",
    "import { DeepSyncCore } from '@deepsync/core'",
    "import { nodeVersionCheck } from '@deepsync/doctor'",
    "import { GITHUB_SOURCE_ID } from '@deepsync/source-github'",
    "import { DSH_ADAPTER_ID, SUPPORTED_DSH_VERSION } from '@deepsync/target-dsh'",
    "import { VERSION } from 'deepsync'",
    "if (typeof contracts !== 'object') throw new Error('Contracts import failed')",
    "if (new DeepSyncCore().listAdapters().length !== 0) throw new Error('Core is not target-neutral by default')",
    "if (nodeVersionCheck('24.0.0').id !== 'runtime.node') throw new Error('Doctor API smoke failed')",
    "if (GITHUB_SOURCE_ID !== 'github-public-release') throw new Error('GitHub source API smoke failed')",
    "if (DSH_ADAPTER_ID !== 'dsh' || SUPPORTED_DSH_VERSION !== '0.1.1-rc.2') throw new Error('DSH target API smoke failed')",
    `if (VERSION !== ${JSON.stringify(manifests.find(manifest => manifest.name === 'deepsync').version)}) throw new Error('CLI API version mismatch')`,
    '',
  ].join(';\n'))
  const smoke = spawnSync(process.execPath, ['smoke.mjs'], { cwd: directory, stdio: 'inherit', windowsHide: true })
  if (smoke.status !== 0) process.exit(smoke.status ?? 1)
  const cliManifest = manifests.find(manifest => manifest.name === 'deepsync')
  const installedCli = JSON.parse(await readFile(join(directory, 'node_modules', 'deepsync', 'package.json'), 'utf8'))
  const version = spawnSync(process.execPath, [join(directory, 'node_modules', 'deepsync', installedCli.bin.deepsync), '--version'], { cwd: directory, encoding: 'utf8', windowsHide: true })
  if (version.status !== 0 || version.stdout.trim() !== cliManifest.version) throw new Error(`Packed CLI smoke failed: ${version.stderr || version.stdout}`)
  process.stdout.write(`offline packed consumer smoke passed for ${manifests.length} packages\n`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
