import { createHash } from 'node:crypto'
import type { ArtifactDigest, JsonValue, PlanDigest, RequestFingerprint } from '@deepsync/contracts'
import { DeepSyncError } from '../errors/index.ts'

function normalize(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DeepSyncError('INVALID_JSON', 'JSON numbers must be finite')
    return value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const key of Object.keys(value).sort()) {
      const nested = (value as Readonly<Record<string, JsonValue>>)[key]
      if (nested === undefined) throw new DeepSyncError('INVALID_JSON', `JSON property ${JSON.stringify(key)} is undefined`)
      result[key] = normalize(nested)
    }
    return result
  }
  throw new DeepSyncError('INVALID_JSON', 'Value is not JSON-compatible')
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value))
}

export function sha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function requestFingerprint(intent: JsonValue): RequestFingerprint {
  return `sha256:${sha256(intent)}` as RequestFingerprint
}

export function planDigest(plan: JsonValue): PlanDigest {
  return `sha256:${sha256(plan)}` as PlanDigest
}

export function artifactDigest(bytes: Uint8Array): ArtifactDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as ArtifactDigest
}
