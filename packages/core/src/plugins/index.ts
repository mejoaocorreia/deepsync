import type { PluginManifest } from '@deepsync/contracts'

export function validatePluginManifest(manifest: PluginManifest): PluginManifest {
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported plugin manifest version')
  if (manifest.packageName.trim() === '' || manifest.version.trim() === '') throw new Error('Plugin package name and version are required')
  return manifest
}
