import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactDigest } from '@deepsync/contracts'

function artifactDigest(bytes: Uint8Array): ArtifactDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as ArtifactDigest
}
import { describe, expect, it } from 'vitest'
import { GitHubReleaseSource } from '../src/index.ts'

describe('GitHubReleaseSource', () => {
  it('downloads a public asset and verifies its declared digest', async () => {
    const bytes = new TextEncoder().encode('artifact')
    const directory = await mkdtemp(join(tmpdir(), 'deepsync-github-'))
    try {
      const source = new GitHubReleaseSource({
        downloadDirectory: directory,
        fetcher: async () => new Response(bytes, { status: 200 }),
      })
      const digest = artifactDigest(bytes)
      const result = await source.resolve({ owner: 'owner', repository: 'repo', tag: 'v1.0.0', asset: 'plugin.tgz', digest })
      expect(result.digest).toBe(digest)
      expect(await source.verifyCached(result.location, digest)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects unsafe references', async () => {
    const source = new GitHubReleaseSource({ downloadDirectory: tmpdir(), fetcher: async () => new Response('unused') })
    await expect(source.resolve({ owner: '..', repository: 'repo', tag: 'v1', asset: 'plugin.tgz', digest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow(/invalid GitHub owner/iu)
  })

  it('rejects a digest mismatch', async () => {
    const source = new GitHubReleaseSource({ downloadDirectory: tmpdir(), fetcher: async () => new Response('wrong') })
    await expect(source.resolve({ owner: 'owner', repository: 'repo', tag: 'v1', asset: 'plugin.tgz', digest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow(/digest mismatch/u)
  })
})
