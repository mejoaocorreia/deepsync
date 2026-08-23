export type DeepSyncErrorCode =
  | 'ADAPTER_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_JSON'
  | 'PLAN_QUARANTINED'
  | 'TRANSACTION_IN_PROGRESS'
  | 'STATE_CONFLICT'
  | 'STATE_CORRUPT'
  | 'HEALTH_FAILED'
  | 'ROLLBACK_FAILED'
  | 'INVALID_LOCKFILE'
  | 'DEPENDENCY_CYCLE'
  | 'DEPENDENCY_MISSING'

export class DeepSyncError extends Error {
  constructor(readonly code: DeepSyncErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DeepSyncError'
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
