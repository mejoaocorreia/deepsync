import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactDigest } from '@deepsync/contracts'
import { describe, expect, it, vi } from 'vitest'
import { GitHubReleaseSource } from '../src/index.ts'

function artifactDigest(bytes: Uint8Array): ArtifactDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as ArtifactDigest
}

const reference = (digest: ArtifactDigest) => ({ schemaVersion: 1, kind: 'github-release', owner: 'owner', repository: 'repo', tag: 'v1.0.0', asset: 'plugin.tgz', digest } as const)

describe('GitHubReleaseSource', () => {
  it('streams, verifies, and reuses a full-digest offline cache', async () => {
    const bytes = new TextEncoder().encode('artifact')
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-github-'))
    const fetcher = vi.fn(async () => new Response(bytes, { status: 200 }))
    try {
      const source = new GitHubReleaseSource({ downloadDirectory: directory, fetcher })
      const digest = artifactDigest(bytes)
      const first = await source.resolve(reference(digest))
      const second = await source.resolve(reference(digest))
      expect(first.digest).toBe(digest)
      expect(first.location).toContain(digest.slice('sha256:'.length))
      expect(second.evidence[0]?.checkId).toBe('source.github.cache')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(await source.verifyCached(first.location, digest)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects unsafe or unknown reference fields', async () => {
    const source = new GitHubReleaseSource({ downloadDirectory: tmpdir(), fetcher: async () => new Response('unused') })
    await expect(source.resolve({ ...reference(`sha256:${'0'.repeat(64)}` as ArtifactDigest), owner: '..' })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
    await expect(source.resolve({ ...reference(`sha256:${'0'.repeat(64)}` as ArtifactDigest), extra: true })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
  })

  it('rejects mutable tags and reports not-found and rate-limit outcomes', async () => {
    const digest = `sha256:${'0'.repeat(64)}` as ArtifactDigest
    const source = new GitHubReleaseSource({ downloadDirectory: tmpdir(), fetcher: async () => new Response('', { status: 404 }) })
    await expect(source.resolve({ ...reference(digest), tag: 'latest' })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
    await expect(source.resolve(reference(digest))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const limited = new GitHubReleaseSource({ downloadDirectory: tmpdir(), fetcher: async () => new Response('', { status: 429 }) })
    await expect(limited.resolve(reference(digest))).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('rejects digest mismatches and response size violations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-github-fail-'))
    try {
      const expected = `sha256:${'0'.repeat(64)}` as ArtifactDigest
      const mismatch = new GitHubReleaseSource({ downloadDirectory: directory, fetcher: async () => new Response('wrong') })
      await expect(mismatch.resolve(reference(expected))).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
      const oversized = new GitHubReleaseSource({ downloadDirectory: directory, maxBytes: 2, fetcher: async () => new Response('large') })
      await expect(oversized.resolve(reference(artifactDigest(new TextEncoder().encode('large'))))).rejects.toMatchObject({ code: 'SIZE_LIMIT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
