import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ArtifactDigest, PluginManifest } from '@deepsync/contracts'
import { artifactDigest } from '@deepsync/core'

export interface DshBundleManifest {
  readonly packageName: string
  readonly version: string
  readonly patchPath: string
  readonly deepSync: PluginManifest
  readonly artifactDigest: ArtifactDigest
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${subject} must be an object`)
  return value as Record<string, unknown>
}

export async function readDshBundleManifest(packageRoot: string): Promise<DshBundleManifest> {
  const root = await realpath(packageRoot)
  const packageText = await readFile(resolve(root, 'package.json'), 'utf8')
  const packageJson = object(JSON.parse(packageText), 'package.json')
  if (typeof packageJson.name !== 'string' || packageJson.name.trim() === '') throw new Error('package.json name is required')
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') throw new Error('package.json version is required')
  const dsh = object(packageJson.dsh, 'package.json dsh')
  const bundle = object(dsh.bundle, 'package.json dsh.bundle')
  if (typeof bundle.patch !== 'string' || bundle.patch.trim() === '' || isAbsolute(bundle.patch)) throw new Error('dsh.bundle.patch must be a relative path')
  const patchPath = await realpath(resolve(root, bundle.patch))
  const relation = relative(root, patchPath)
  if (relation.startsWith('..') || isAbsolute(relation)) throw new Error('dsh.bundle.patch escapes the package root')
  if (!(await stat(patchPath)).isFile()) throw new Error('dsh.bundle.patch must identify a file')
  const deepSyncText = await readFile(resolve(root, 'deepsync.manifest.json'), 'utf8')
  const deepSync = object(JSON.parse(deepSyncText), 'deepsync.manifest.json') as unknown as PluginManifest
  if (deepSync.schemaVersion !== 1 || deepSync.packageName !== packageJson.name || deepSync.version !== packageJson.version) {
    throw new Error('DeepSync manifest identity does not match package.json')
  }
  const patchText = await readFile(patchPath)
  return {
    packageName: packageJson.name,
    version: packageJson.version,
    patchPath,
    deepSync,
    artifactDigest: artifactDigest(Buffer.concat([Buffer.from(packageText), Buffer.from(deepSyncText), patchText])),
  }
}
