import type { CapabilityRequirement, CompatibilityReport, Evidence } from '@deepsync/contracts'

export function evaluateCapabilities(required: readonly CapabilityRequirement[], available: readonly CapabilityRequirement[], observedAt: string): CompatibilityReport {
  const availableIds = new Set(available.map(item => item.id))
  const evidence: Evidence[] = required.map(capability => ({
    checkId: `capability:${capability.id}`,
    status: availableIds.has(capability.id) ? 'pass' : capability.requirement === 'required' ? 'fail' : 'warn',
    summary: availableIds.has(capability.id) ? `Capability ${capability.id} is available` : `Capability ${capability.id} is unavailable`,
    observedAt,
  }))
  const requiredSatisfied = required.filter(item => item.requirement === 'required').every(item => availableIds.has(item.id))
  return { compatible: requiredSatisfied, requiredSatisfied, evidence }
}
