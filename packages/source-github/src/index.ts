import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ArtifactDigest, ArtifactSource, Evidence, JsonValue } from '@deepsync/contracts'

function artifactDigest(bytes: Uint8Array): ArtifactDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as ArtifactDigest
}

export const GITHUB_SOURCE_ID = 'github-public-release'

export class GitHubSourceError extends Error {
  constructor(readonly code: 'INVALID_REFERENCE' | 'HTTP_ERROR' | 'SIZE_LIMIT' | 'DIGEST_MISMATCH' | 'CACHE_ERROR', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GitHubSourceError'
  }
}

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
  readonly maxBytes?: number
}

function segment(value: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || value === '.' || value === '..') throw new GitHubSourceError('INVALID_REFERENCE', `Invalid GitHub ${name}`)
  return value
}

function parseReference(value: JsonValue): GitHubReleaseReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new GitHubSourceError('INVALID_REFERENCE', 'GitHub reference must be an object')
  const input = value as Readonly<Record<string, JsonValue>>
  if (Object.keys(input).some(key => !['owner', 'repository', 'tag', 'asset', 'digest'].includes(key))
    || typeof input.owner !== 'string' || typeof input.repository !== 'string' || typeof input.tag !== 'string'
    || typeof input.asset !== 'string' || typeof input.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(input.digest)) {
    throw new GitHubSourceError('INVALID_REFERENCE', 'GitHub reference fields are invalid')
  }
  return { owner: segment(input.owner, 'owner'), repository: segment(input.repository, 'repository'), tag: segment(input.tag, 'tag'), asset: segment(input.asset, 'asset'), digest: input.digest as ArtifactDigest }
}

export class GitHubReleaseSource implements ArtifactSource {
  readonly id = GITHUB_SOURCE_ID
  readonly #fetcher: typeof fetch
  readonly #maxBytes: number

  constructor(readonly options: GitHubSourceOptions) {
    this.#fetcher = options.fetcher ?? fetch
    this.#maxBytes = options.maxBytes ?? 50 * 1024 * 1024
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) throw new GitHubSourceError('SIZE_LIMIT', 'GitHub source maxBytes must be a positive safe integer')
  }

  async resolve(referenceValue: JsonValue) {
    const reference = parseReference(referenceValue)
    await mkdir(this.options.downloadDirectory, { recursive: true })
    const filename = join(this.options.downloadDirectory, `${reference.digest.slice('sha256:'.length)}-${basename(reference.asset)}`)
    if (await this.verifyCached(filename, reference.digest)) {
      const evidence: Evidence[] = [{ checkId: 'source.github.cache', status: 'pass', summary: `Reused verified cached ${reference.asset}`, observedAt: new Date().toISOString(), data: { digest: reference.digest } }]
      return { location: filename, digest: reference.digest, evidence }
    }

    const url = `https://github.com/${reference.owner}/${reference.repository}/releases/download/${reference.tag}/${reference.asset}`
    const response = await this.#fetcher(url, { redirect: 'follow' })
    if (!response.ok) throw new GitHubSourceError('HTTP_ERROR', `GitHub release asset returned HTTP ${response.status}`)
    if (response.body === null) throw new GitHubSourceError('HTTP_ERROR', 'GitHub release asset has no response body')
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > this.#maxBytes) throw new GitHubSourceError('SIZE_LIMIT', `GitHub release asset exceeds ${this.#maxBytes} bytes`)

    const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256')
    let size = 0
    try {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > this.#maxBytes) {
          await reader.cancel()
          throw new GitHubSourceError('SIZE_LIMIT', `GitHub release asset exceeds ${this.#maxBytes} bytes`)
        }
        hash.update(value)
        await handle.write(value)
      }
      await handle.sync()
    } catch (error) {
      await handle.close()
      await rm(temporary, { force: true })
      throw error
    }
    await handle.close()
    const observed = `sha256:${hash.digest('hex')}` as ArtifactDigest
    if (observed !== reference.digest) {
      await rm(temporary, { force: true })
      throw new GitHubSourceError('DIGEST_MISMATCH', `GitHub artifact digest mismatch: expected ${reference.digest}, observed ${observed}`)
    }
    try {
      await rename(temporary, filename)
    } catch (error) {
      if (!await this.verifyCached(filename, reference.digest)) {
        await rm(temporary, { force: true })
        throw new GitHubSourceError('CACHE_ERROR', `Cannot publish verified GitHub artifact ${filename}`, { cause: error })
      }
      await rm(temporary, { force: true })
    }
    const evidence: Evidence[] = [{
      checkId: 'source.github.digest',
      status: 'pass',
      summary: `Verified ${reference.owner}/${reference.repository}@${reference.tag}/${reference.asset}`,
      observedAt: new Date().toISOString(),
      data: { url, digest: observed, size },
    }]
    return { location: filename, digest: observed, evidence }
  }

  async verifyCached(location: string, expected: ArtifactDigest): Promise<boolean> {
    try {
      return artifactDigest(await readFile(location)) === expected
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new GitHubSourceError('CACHE_ERROR', `Cannot verify cached artifact ${location}`, { cause: error })
    }
  }
}
