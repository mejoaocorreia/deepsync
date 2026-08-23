import type { DoctorCheck, Evidence } from '@deepsync/contracts'

export interface DoctorReport {
  readonly healthy: boolean
  readonly evidence: readonly Evidence[]
}

export async function runDoctor(checks: readonly DoctorCheck[]): Promise<DoctorReport> {
  const evidence: Evidence[] = []
  for (const check of checks) evidence.push(await check.run())
  return { healthy: evidence.every(item => item.status !== 'fail'), evidence }
}
