import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ArtifactDigest, ArtifactSource, Evidence, JsonValue } from '@deepsync/contracts'

function artifactDigest(bytes: Uint8Array): ArtifactDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as ArtifactDigest
}

export const GITHUB_SOURCE_ID = 'github-public-release'

export interface GitHubReleaseReference {
  readonly owner: string
  readonly repository: string
  readonly tag: string
  readonly asset: string
  readonly digest: ArtifactDigest
}

export interface GitHubSourceOptions {
  readonly downloadDirectory: string
  readonly fetcher?: typeof fetch
}

function segment(value: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || value === '.' || value === '..') throw new Error(`Invalid GitHub ${name}`)
  return value
}

function parseReference(value: JsonValue): GitHubReleaseReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub reference must be an object')
  const input = value as Readonly<Record<string, JsonValue>>
  if (typeof input.owner !== 'string' || typeof input.repository !== 'string' || typeof input.tag !== 'string'
    || typeof input.asset !== 'string' || typeof input.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(input.digest)) {
    throw new Error('GitHub reference fields are invalid')
  }
  return {
    owner: segment(input.owner, 'owner'),
    repository: segment(input.repository, 'repository'),
    tag: segment(input.tag, 'tag'),
    asset: segment(input.asset, 'asset'),
    digest: input.digest as ArtifactDigest,
  }
}

export class GitHubReleaseSource implements ArtifactSource {
  readonly id = GITHUB_SOURCE_ID
  readonly #fetcher: typeof fetch

  constructor(readonly options: GitHubSourceOptions) {
    this.#fetcher = options.fetcher ?? fetch
  }

  async resolve(referenceValue: JsonValue) {
    const reference = parseReference(referenceValue)
    const url = `https://github.com/${reference.owner}/${reference.repository}/releases/download/${reference.tag}/${reference.asset}`
    const response = await this.#fetcher(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`GitHub release asset returned HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const observed = artifactDigest(bytes)
    if (observed !== reference.digest) throw new Error(`GitHub artifact digest mismatch: expected ${reference.digest}, observed ${observed}`)
    await mkdir(this.options.downloadDirectory, { recursive: true })
    const filename = join(this.options.downloadDirectory, `${reference.digest.slice(7, 23)}-${basename(reference.asset)}`)
    const temporary = `${filename}.${process.pid}.tmp`
    await writeFile(temporary, bytes, { mode: 0o600 })
    await rename(temporary, filename)
    const evidence: Evidence[] = [{
      checkId: 'source.github.digest',
      status: 'pass',
      summary: `Verified ${reference.owner}/${reference.repository}@${reference.tag}/${reference.asset}`,
      observedAt: new Date().toISOString(),
      data: { url, digest: observed, size: bytes.byteLength },
    }]
    return { location: filename, digest: observed, evidence }
  }

  async verifyCached(location: string, expected: ArtifactDigest): Promise<boolean> {
    return artifactDigest(await readFile(location)) === expected
  }
}
