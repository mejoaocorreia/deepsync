import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { ArtifactDigest } from '@deepsync/contracts'
import { DeepSyncError, artifactDigest } from '@deepsync/core'
import { t, x } from 'tar'
import { readDshBundleManifest, type DshBundleManifest } from './manifest.ts'
import { runCommand, scrubEnvironment, type DshCommand } from './process.ts'

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 10_000

export interface PackedDshArtifact extends DshBundleManifest {
  readonly artifactPath: string
  readonly artifactDigest: ArtifactDigest
  readonly size: number
  readonly entries: readonly string[]
}

function safeArchivePath(path: string): boolean {
  return (path === 'package/' || path.startsWith('package/')) && !path.split('/').includes('..') && !path.includes('\\')
}

export async function inspectPackedDshArtifact(filename: string): Promise<PackedDshArtifact> {
  const artifactPath = await realpath(filename)
  const details = await stat(artifactPath)
  if (!details.isFile() || details.size <= 0 || details.size > MAX_ARCHIVE_BYTES) throw new DeepSyncError('ARTIFACT_INVALID', `Artifact archive size is outside the supported range: ${details.size}`)
  const entries: string[] = []
  let unpackedBytes = 0
  await t({
    file: artifactPath,
    onentry(entry) {
      if (!safeArchivePath(entry.path)) throw new DeepSyncError('ARTIFACT_INVALID', `Unsafe artifact archive path: ${entry.path}`)
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') throw new DeepSyncError('ARTIFACT_INVALID', `Artifact archive links are not allowed: ${entry.path}`)
      entries.push(entry.path)
      unpackedBytes += entry.size
      if (entries.length > MAX_ENTRIES || unpackedBytes > MAX_UNPACKED_BYTES) throw new DeepSyncError('ARTIFACT_INVALID', 'Artifact archive expands beyond supported limits')
    },
  })
  for (const required of ['package/package.json', 'package/deepsync.manifest.json']) {
    if (!entries.includes(required)) throw new DeepSyncError('ARTIFACT_INVALID', `Artifact archive is missing ${required}`)
  }
  const directory = await mkdtemp(join(tmpdir(), 'deepsync-artifact-'))
  try {
    await x({ file: artifactPath, cwd: directory, strip: 1, preservePaths: false })
    const manifest = await readDshBundleManifest(directory)
    const bytes = await readFile(artifactPath)
    return { ...manifest, artifactPath, artifactDigest: artifactDigest(bytes), size: bytes.byteLength, entries: entries.sort() }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function cachePackedDshArtifact(filename: string, cacheDirectory: string): Promise<PackedDshArtifact> {
  const source = await inspectPackedDshArtifact(filename)
  await mkdir(cacheDirectory, { recursive: true })
  const destination = join(resolve(cacheDirectory), `${source.artifactDigest.slice('sha256:'.length)}-${basename(source.artifactPath)}`)
  try {
    const existing = await inspectPackedDshArtifact(destination)
    if (existing.artifactDigest !== source.artifactDigest) throw new DeepSyncError('ARTIFACT_INVALID', `Artifact cache collision at ${destination}`)
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof DeepSyncError && /not readable/u.test(error.message))) throw error
  }
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`
  try {
    await copyFile(source.artifactPath, temporary, constants.COPYFILE_EXCL)
    if ((await inspectPackedDshArtifact(temporary)).artifactDigest !== source.artifactDigest) throw new DeepSyncError('ARTIFACT_INVALID', 'Local artifact cache copy changed bytes')
    await chmod(temporary, 0o400)
    try {
      await rename(temporary, destination)
    } catch (error) {
      try {
        if ((await inspectPackedDshArtifact(destination)).artifactDigest !== source.artifactDigest) throw error
      } catch {
        throw error
      }
    }
    return await inspectPackedDshArtifact(destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function publishPackedArtifact(source: string, destination: string, expected: ArtifactDigest): Promise<void> {
  try {
    await rename(source, destination)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL)
    if ((await inspectPackedDshArtifact(temporary)).artifactDigest !== expected) throw new DeepSyncError('ARTIFACT_INVALID', 'Cross-volume artifact copy changed bytes')
    await chmod(temporary, 0o400)
    try {
      await rename(temporary, destination)
    } catch (error) {
      try {
        if ((await inspectPackedDshArtifact(destination)).artifactDigest !== expected) throw error
      } catch {
        throw error
      }
    }
    await rm(source, { force: true })
  } finally {
    await rm(temporary, { force: true })
  }
}

function pnpmPackCommand(relativeDestination: string, cwd: string): DshCommand {
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec ?? 'cmd.exe', prefixArgs: ['/d', '/s', '/c', `pnpm pack --pack-destination ${relativeDestination} --json`], cwd }
  }
  return { command: 'pnpm', prefixArgs: ['pack', '--pack-destination', relativeDestination, '--json'], cwd }
}

export async function packLocalDshArtifact(packageRoot: string, cacheDirectory: string): Promise<PackedDshArtifact> {
  const sourceRoot = await realpath(packageRoot)
  await readDshBundleManifest(sourceRoot)
  const relativeDestination = `.deepsync-pack-${crypto.randomUUID()}`
  const packDirectory = join(sourceRoot, relativeDestination)
  await mkdir(packDirectory)
  try {
    const result = await runCommand(pnpmPackCommand(relativeDestination, sourceRoot), [], scrubEnvironment(), 120_000)
    if (result.exitCode !== 0) throw new DeepSyncError('ARTIFACT_INVALID', `pnpm pack failed: ${result.stderr || result.stdout}`)
    let output: { filename?: unknown }
    try {
      output = JSON.parse(result.stdout) as { filename?: unknown }
    } catch (error) {
      throw new DeepSyncError('ARTIFACT_INVALID', 'pnpm pack did not return valid JSON', { cause: error })
    }
    if (typeof output.filename !== 'string') throw new DeepSyncError('ARTIFACT_INVALID', 'pnpm pack did not return an artifact filename')
    const packed = await inspectPackedDshArtifact(resolve(sourceRoot, output.filename))
    await mkdir(cacheDirectory, { recursive: true })
    const digestName = packed.artifactDigest.slice('sha256:'.length)
    const destination = join(resolve(cacheDirectory), `${digestName}-${basename(output.filename)}`)
    try {
      const existing = await inspectPackedDshArtifact(destination)
      if (existing.artifactDigest !== packed.artifactDigest) throw new DeepSyncError('ARTIFACT_INVALID', `Artifact cache collision at ${destination}`)
      return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof DeepSyncError && /not readable/u.test(error.message))) throw error
    }
    await publishPackedArtifact(packed.artifactPath, destination, packed.artifactDigest)
    await chmod(destination, 0o400)
    return await inspectPackedDshArtifact(destination)
  } finally {
    await rm(packDirectory, { recursive: true, force: true })
  }
}
