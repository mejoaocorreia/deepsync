import type { Evidence, HealthReport, TargetHealth } from '@deepsync/contracts'

export function healthReport(evidence: readonly Evidence[]): HealthReport {
  return { healthy: evidence.every(item => item.status !== 'fail'), evidence }
}

export function targetHealthReport(health: TargetHealth): HealthReport {
  return { healthy: health.ok, evidence: health.evidence }
}
