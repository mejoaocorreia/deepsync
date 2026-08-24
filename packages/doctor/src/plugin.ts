import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ContractValidationError, type ArtifactDigest, type ValidationIssue, type ValidationIssueCode } from '@deepsync/contracts'
import { DeepSyncError } from '@deepsync/core'
import { inspectPackedDshArtifact, readDshBundleManifest } from '@deepsync/target-dsh'

export interface PluginValidationReport {
  readonly valid: boolean
  readonly input: string
  readonly inputKind: 'directory' | 'artifact' | 'unknown'
  readonly packageName?: string
  readonly version?: string
  readonly pluginId?: string
  readonly artifactDigest?: ArtifactDigest
  readonly issues: readonly ValidationIssue[]
}

function issue(code: ValidationIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return { code, path, message, remediation }
}

function contractIssues(error: unknown): readonly ValidationIssue[] | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof ContractValidationError) return current.issues
    current = current.cause
  }
  return undefined
}

function artifactIssue(error: unknown): ValidationIssue {
  const message = error instanceof Error ? error.message : String(error)
  if (/not readable|ENOENT|cannot find/iu.test(message)) return issue('INPUT_NOT_FOUND', '', message, 'Provide a readable plugin directory or packed .tgz artifact.')
  if (/not valid JSON/iu.test(message)) return issue('JSON_INVALID', '', message, 'Fix the JSON syntax and run validation again.')
  if (/identity does not match/iu.test(message)) return issue('PACKAGE_IDENTITY_MISMATCH', '/packageName', message, 'Make package.json and deepsync.manifest.json name and version identical.')
  if (/main|entrypoint/iu.test(message)) return issue('PACKAGE_ENTRYPOINT_MISSING', '/main', message, 'Declare and publish a readable plugin entrypoint.')
  if (/package\.json files/iu.test(message)) return issue('PACKAGE_FILES_INVALID', '/files', message, 'List the entrypoint, deepsync.manifest.json, and dsh.bundle.patch file in package.json files.')
  if (/archive path|archive links|expands beyond|archive is missing/iu.test(message)) return issue('ARTIFACT_ARCHIVE_UNSAFE', '', message, 'Repack the plugin without links, traversal, missing declarations, or oversized content.')
  if (/digest|bytes changed|collision/iu.test(message)) return issue('ARTIFACT_DIGEST_MISMATCH', '', message, 'Use the digest of the complete immutable .tgz bytes.')
  if (/Node\.js|DSH 0\.1\.1|dsh\.profile\.bundle/iu.test(message)) return issue('DSH_RUNTIME_UNSUPPORTED', '/targets/dsh/runtime', message, 'Target DSH 0.1.1-rc.2, its required bundle capability, and a Node.js range supported by the current runtime.')
  if (/patch/iu.test(message)) return issue('DSH_PATCH_INVALID', '/dsh/bundle/patch', message, 'Declare a confined readable Cordis patch and include it in package.json files.')
  return issue('DSH_PACKAGE_METADATA_INVALID', '', message, 'Fix the DSH package metadata reported by the validator.')
}

export async function validatePluginInput(input: string): Promise<PluginValidationReport> {
  const absolute = resolve(input)
  let details
  try {
    details = await stat(absolute)
  } catch (error) {
    return { valid: false, input: absolute, inputKind: 'unknown', issues: [artifactIssue(error)] }
  }
  try {
    if (details.isDirectory()) {
      const manifest = await readDshBundleManifest(absolute)
      return {
        valid: true,
        input: absolute,
        inputKind: 'directory',
        packageName: manifest.packageName,
        version: manifest.version,
        pluginId: manifest.deepSync.id,
        issues: [],
      }
    }
    if (!details.isFile()) return { valid: false, input: absolute, inputKind: 'unknown', issues: [issue('INPUT_NOT_FOUND', '', 'Plugin input is not a directory or file', 'Provide a plugin directory or packed .tgz artifact.')] }
    const artifact = await inspectPackedDshArtifact(absolute)
    return {
      valid: true,
      input: absolute,
      inputKind: 'artifact',
      packageName: artifact.packageName,
      version: artifact.version,
      pluginId: artifact.deepSync.id,
      artifactDigest: artifact.artifactDigest,
      issues: [],
    }
  } catch (error) {
    return {
      valid: false,
      input: absolute,
      inputKind: details.isDirectory() ? 'directory' : 'artifact',
      issues: contractIssues(error) ?? [artifactIssue(error instanceof DeepSyncError ? error : new Error(String(error), { cause: error }))],
    }
  }
}
