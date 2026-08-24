import { describe, expect, it } from 'vitest'
import {
  DSH_HEALTH_RESULT_SCHEMA_V1,
  DSH_TARGET_BINDING_SCHEMA_V1,
  PLUGIN_MANIFEST_SCHEMA_V1,
  validateDshHealthResultDocument,
  validateDshTargetBindingDocument,
  validatePluginManifestDocument,
  type ActivationAttemptId,
  type DshHealthResultV1,
  type DshTargetBindingV1,
  type PluginId,
  type PluginManifestV1,
  type TargetInstanceId,
} from '../src/index.ts'

const binding = {
  schemaVersion: 1,
  target: 'dsh',
  runtime: {
    name: 'deepseek-harness',
    version: '0.1.1-rc.2',
    node: '^22.19.0 || >=24.0.0',
  },
  health: {
    schemaVersion: 1,
    protocol: 'deepsync.health/v1',
    transport: 'json-file',
    path: 'state/plugin-health.json',
  },
} as const satisfies DshTargetBindingV1

const manifest = {
  schemaVersion: 1,
  id: 'external-probe' as PluginId,
  packageName: '@external/external-probe',
  version: '1.2.3-alpha.1',
  capabilities: [{ id: 'dsh.profile.bundle', portability: 'target-specific', requirement: 'required', version: '0.1.1-rc.2' }],
  targets: { dsh: binding },
} as const satisfies PluginManifestV1

const health = {
  schemaVersion: 1,
  protocol: 'deepsync.health/v1',
  pluginId: manifest.id,
  pluginVersion: manifest.version,
  targetInstanceId: 'dsh:test' as TargetInstanceId,
  activationAttemptId: 'attempt-1' as ActivationAttemptId,
  status: 'healthy',
  observedAt: '2026-08-24T00:00:00.000Z',
  data: { ready: true },
} as const satisfies DshHealthResultV1

describe('public plugin contracts', () => {
  it('keeps exported schemas and TypeScript examples aligned', () => {
    expect(PLUGIN_MANIFEST_SCHEMA_V1.$id).toBe('https://deepsync.dev/schemas/plugin-manifest-v1.json')
    expect(DSH_TARGET_BINDING_SCHEMA_V1.$id).toBe('https://deepsync.dev/schemas/dsh-target-binding-v1.json')
    expect(DSH_HEALTH_RESULT_SCHEMA_V1.$id).toBe('https://deepsync.dev/schemas/dsh-health-result-v1.json')
    expect(validateDshTargetBindingDocument(binding)).toEqual({ valid: true, value: binding, issues: [] })
    expect(validatePluginManifestDocument(manifest)).toEqual({ valid: true, value: manifest, issues: [] })
    expect(validateDshHealthResultDocument(health)).toEqual({ valid: true, value: health, issues: [] })
  })

  it('returns stable codes and JSON Pointer paths for invalid documents', () => {
    const invalidManifest = validatePluginManifestDocument({ ...manifest, version: 'not-semver', surprise: true })
    expect(invalidManifest.valid).toBe(false)
    if (invalidManifest.valid) return
    expect(invalidManifest.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SCHEMA_PATTERN', path: '/version' }),
      expect.objectContaining({ code: 'SCHEMA_ADDITIONAL_PROPERTY', path: '/surprise' }),
    ]))

    const invalidHealth = validateDshHealthResultDocument({ ...health, activationAttemptId: '', status: 'maybe' })
    expect(invalidHealth.valid).toBe(false)
    if (invalidHealth.valid) return
    expect(invalidHealth.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SCHEMA_MIN_LENGTH', path: '/activationAttemptId' }),
      expect.objectContaining({ code: 'SCHEMA_ENUM', path: '/status' }),
    ]))
  })
})
