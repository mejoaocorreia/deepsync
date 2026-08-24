import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { PluginManifest } from '@deepsync/contracts'
import { DeepSyncError, validatePluginManifest } from '@deepsync/core'
import { SUPPORTED_DSH_VERSION } from './constants.ts'

export interface DshBundleManifest {
  readonly packageName: string
  readonly version: string
  readonly patchPath: string
  readonly healthPath: string
  readonly deepSync: PluginManifest
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeepSyncError('ARTIFACT_INVALID', `${subject} must be an object`)
  return value as Record<string, unknown>
}

function parseJson(text: string, subject: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new DeepSyncError('ARTIFACT_INVALID', `${subject} is not valid JSON`, { cause: error })
  }
}

export async function readDshBundleManifest(packageRoot: string): Promise<DshBundleManifest> {
  let root: string
  try {
    root = await realpath(packageRoot)
  } catch (error) {
    throw new DeepSyncError('ARTIFACT_INVALID', `Artifact package root is not readable: ${packageRoot}`, { cause: error })
  }
  const packageText = await readFile(resolve(root, 'package.json'), 'utf8')
  const packageJson = object(parseJson(packageText, 'package.json'), 'package.json')
  if (typeof packageJson.name !== 'string' || packageJson.name.trim() === '') throw new DeepSyncError('ARTIFACT_INVALID', 'package.json name is required')
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') throw new DeepSyncError('ARTIFACT_INVALID', 'package.json version is required')
  if (typeof packageJson.main !== 'string' && packageJson.exports === undefined) throw new DeepSyncError('ARTIFACT_INVALID', 'package.json must declare main or exports')
  const dsh = object(packageJson.dsh, 'package.json dsh')
  const bundle = object(dsh.bundle, 'package.json dsh.bundle')
  if (typeof bundle.patch !== 'string' || bundle.patch.trim() === '' || isAbsolute(bundle.patch)) throw new DeepSyncError('ARTIFACT_INVALID', 'dsh.bundle.patch must be a relative path')
  const patchPath = await realpath(resolve(root, bundle.patch))
  const relation = relative(root, patchPath)
  if (relation.startsWith('..') || isAbsolute(relation)) throw new DeepSyncError('ARTIFACT_INVALID', 'dsh.bundle.patch escapes the package root')
  if (!(await stat(patchPath)).isFile()) throw new DeepSyncError('ARTIFACT_INVALID', 'dsh.bundle.patch must identify a file')
  const deepSyncText = await readFile(resolve(root, 'deepsync.manifest.json'), 'utf8')
  let deepSync: PluginManifest
  try {
    deepSync = validatePluginManifest(object(parseJson(deepSyncText, 'deepsync.manifest.json'), 'deepsync.manifest.json') as unknown as PluginManifest)
  } catch (error) {
    if (error instanceof DeepSyncError && error.code === 'ARTIFACT_INVALID') throw error
    throw new DeepSyncError('ARTIFACT_INVALID', error instanceof Error ? error.message : String(error), { cause: error })
  }
  if (deepSync.packageName !== packageJson.name || deepSync.version !== packageJson.version) throw new DeepSyncError('ARTIFACT_INVALID', 'DeepSync manifest identity does not match package.json')
  const dshTarget = object(deepSync.targets.dsh, 'deepsync.manifest.json targets.dsh')
  if (dshTarget.version !== SUPPORTED_DSH_VERSION) throw new DeepSyncError('TARGET_UNSUPPORTED', `Artifact must explicitly target DSH ${SUPPORTED_DSH_VERSION}`)
  const health = object(dshTarget.health, 'deepsync.manifest.json targets.dsh.health')
  if (health.kind !== 'json-file' || typeof health.path !== 'string' || health.path === '' || isAbsolute(health.path)
    || health.path.split(/[\\/]/u).includes('..')) throw new DeepSyncError('ARTIFACT_INVALID', 'DSH health must declare a confined json-file path')
  await readFile(patchPath)
  return { packageName: packageJson.name, version: packageJson.version, patchPath, healthPath: health.path, deepSync }
}
