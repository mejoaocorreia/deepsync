import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  ContractValidationError,
  assertDshTargetBindingDocument,
  type DshHealthDeclarationV1,
  type DshTargetBindingV1,
  type PluginManifestV1,
} from '@deepsync/contracts'
import { DeepSyncError, validatePluginManifest } from '@deepsync/core'
import { satisfies, validRange } from 'semver'
import { SUPPORTED_DSH_VERSION } from './constants.ts'

export interface DshBundleManifest {
  readonly packageName: string
  readonly version: string
  readonly patchPath: string
  readonly health: DshHealthDeclarationV1
  readonly binding: DshTargetBindingV1
  readonly deepSync: PluginManifestV1
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

function listedFile(files: readonly unknown[], filename: string): boolean {
  const normalized = filename.replace(/^\.\//u, '')
  return files.some(entry => typeof entry === 'string' && entry.replace(/^\.\//u, '') === normalized)
}

function exportPaths(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : []
  if (Array.isArray(value)) return value.flatMap(exportPaths)
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(exportPaths)
}

async function validateEntrypoint(root: string, files: readonly unknown[], entrypoint: string): Promise<void> {
  let entryPath: string
  try {
    entryPath = await realpath(resolve(root, entrypoint))
  } catch (error) {
    throw new DeepSyncError('ARTIFACT_INVALID', `Published plugin entrypoint is not readable: ${entrypoint}`, { cause: error })
  }
  const relation = relative(root, entryPath)
  if (relation.startsWith('..') || isAbsolute(relation) || !(await stat(entryPath)).isFile()) throw new DeepSyncError('ARTIFACT_INVALID', 'Published plugin entrypoint must identify a file inside the package')
  if (!listedFile(files, entrypoint)) throw new DeepSyncError('ARTIFACT_INVALID', 'package.json files must include every published plugin entrypoint')
}

function contractFailure(error: unknown): never {
  if (error instanceof ContractValidationError) {
    throw new DeepSyncError('ARTIFACT_INVALID', error.message, { cause: error })
  }
  throw error
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
  if (!Array.isArray(packageJson.files)) throw new DeepSyncError('ARTIFACT_INVALID', 'package.json files must explicitly declare the published plugin files')
  if (!listedFile(packageJson.files, 'deepsync.manifest.json')) throw new DeepSyncError('ARTIFACT_INVALID', 'package.json files must include deepsync.manifest.json')
  const entrypoints = typeof packageJson.main === 'string' ? [packageJson.main] : exportPaths(packageJson.exports)
  if (entrypoints.length === 0) throw new DeepSyncError('ARTIFACT_INVALID', 'package.json exports must declare at least one relative plugin entrypoint')
  for (const entrypoint of new Set(entrypoints)) await validateEntrypoint(root, packageJson.files, entrypoint)
  const dsh = object(packageJson.dsh, 'package.json dsh')
  const bundle = object(dsh.bundle, 'package.json dsh.bundle')
  if (typeof bundle.patch !== 'string' || bundle.patch.trim() === '' || isAbsolute(bundle.patch)) throw new DeepSyncError('ARTIFACT_INVALID', 'dsh.bundle.patch must be a relative path')
  if (!listedFile(packageJson.files, bundle.patch)) throw new DeepSyncError('ARTIFACT_INVALID', 'package.json files must include dsh.bundle.patch')
  const patchPath = await realpath(resolve(root, bundle.patch))
  const relation = relative(root, patchPath)
  if (relation.startsWith('..') || isAbsolute(relation)) throw new DeepSyncError('ARTIFACT_INVALID', 'dsh.bundle.patch escapes the package root')
  if (!(await stat(patchPath)).isFile()) throw new DeepSyncError('ARTIFACT_INVALID', 'dsh.bundle.patch must identify a file')
  const deepSyncText = await readFile(resolve(root, 'deepsync.manifest.json'), 'utf8')
  let deepSync: PluginManifestV1
  try {
    deepSync = validatePluginManifest(parseJson(deepSyncText, 'deepsync.manifest.json'))
  } catch (error) {
    contractFailure(error)
  }
  if (deepSync.packageName !== packageJson.name || deepSync.version !== packageJson.version) throw new DeepSyncError('ARTIFACT_INVALID', 'DeepSync manifest identity does not match package.json')
  let binding: DshTargetBindingV1
  try {
    binding = assertDshTargetBindingDocument(deepSync.targets.dsh)
  } catch (error) {
    contractFailure(error)
  }
  if (binding.runtime.version !== SUPPORTED_DSH_VERSION) throw new DeepSyncError('TARGET_UNSUPPORTED', `Artifact must explicitly target DSH ${SUPPORTED_DSH_VERSION}`)
  if (validRange(binding.runtime.node) === null) throw new DeepSyncError('ARTIFACT_INVALID', 'DSH runtime.node must be a valid Node.js semver range')
  if (!satisfies(process.versions.node, binding.runtime.node)) throw new DeepSyncError('TARGET_UNSUPPORTED', `Artifact requires Node.js ${binding.runtime.node}`)
  const bundleCapability = deepSync.capabilities.find(capability => capability.id === 'dsh.profile.bundle' && capability.requirement === 'required')
  if (bundleCapability?.portability !== 'target-specific' || bundleCapability.version !== SUPPORTED_DSH_VERSION) {
    throw new DeepSyncError('TARGET_UNSUPPORTED', `Artifact must require dsh.profile.bundle ${SUPPORTED_DSH_VERSION}`)
  }
  await readFile(patchPath)
  return { packageName: packageJson.name, version: packageJson.version, patchPath, health: binding.health, binding, deepSync }
}
