import { assertPluginManifestDocument, type PluginManifestV1 } from '@deepsync/contracts'

export function validatePluginManifest(manifest: unknown): PluginManifestV1 {
  return assertPluginManifestDocument(manifest)
}
