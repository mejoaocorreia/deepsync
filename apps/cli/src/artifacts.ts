import { resolve } from 'node:path'
import type { ArtifactSourceReferenceV1, Evidence, GitHubReleaseSourceReferenceV1, LocalPackageSourceReferenceV1 } from '@deepsync/contracts'
import { DeepSyncError } from '@deepsync/core'
import { GitHubReleaseSource } from '@deepsync/source-github'
import { inspectPackedDshArtifact, packLocalDshArtifact, type PackedDshArtifact } from '@deepsync/target-dsh'

export interface ResolvedPluginArtifact {
  readonly source: ArtifactSourceReferenceV1
  readonly artifact: PackedDshArtifact
  readonly evidence: readonly Evidence[]
}

export async function resolvePluginArtifact(
  reference: ArtifactSourceReferenceV1,
  cacheDirectory: string,
  fetcher?: typeof fetch,
): Promise<ResolvedPluginArtifact> {
  const cache = resolve(cacheDirectory)
  if (reference.kind === 'local-package') {
    const source: LocalPackageSourceReferenceV1 = { schemaVersion: 1, kind: 'local-package', path: resolve(reference.path) }
    const artifact = await packLocalDshArtifact(source.path, cache)
    return { source, artifact, evidence: [{ checkId: 'source.local.pack', status: 'pass', summary: `Packed ${artifact.packageName}@${artifact.version}`, observedAt: new Date().toISOString(), data: { digest: artifact.artifactDigest } }] }
  }
  const source: GitHubReleaseSourceReferenceV1 = {
    schemaVersion: 1,
    kind: 'github-release',
    owner: reference.owner,
    repository: reference.repository,
    tag: reference.tag,
    asset: reference.asset,
    digest: reference.digest,
  }
  const resolved = await new GitHubReleaseSource({ downloadDirectory: cache, ...(fetcher === undefined ? {} : { fetcher }) }).resolve({
    schemaVersion: source.schemaVersion,
    kind: source.kind,
    owner: source.owner,
    repository: source.repository,
    tag: source.tag,
    asset: source.asset,
    digest: source.digest,
  })
  const artifact = await inspectPackedDshArtifact(resolved.location)
  if (artifact.artifactDigest !== source.digest || resolved.digest !== source.digest) throw new DeepSyncError('ARTIFACT_INVALID', 'Resolved GitHub artifact digest does not match the immutable source reference')
  return { source, artifact, evidence: resolved.evidence }
}
