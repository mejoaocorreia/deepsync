import type { DeepSyncLockfile } from '@deepsync/contracts'
import { DeepSyncError } from '../errors/index.ts'

export function serializeLockfile(lockfile: DeepSyncLockfile): string {
  const entries = [...lockfile.entries].sort((left, right) => left.pluginId.localeCompare(right.pluginId))
  return `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`
}

export function parseLockfile(text: string): DeepSyncLockfile {
  try {
    const value = JSON.parse(text) as Partial<DeepSyncLockfile>
    if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error('unsupported schema')
    return { schemaVersion: 1, entries: value.entries }
  } catch (error) {
    throw new DeepSyncError('INVALID_LOCKFILE', 'DeepSync lockfile is malformed or unsupported', { cause: error })
  }
}
