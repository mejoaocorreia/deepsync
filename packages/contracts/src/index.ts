export type Brand<Value, Name extends string> = Value & { readonly __brand: Name }

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type RequestId = Brand<string, 'RequestId'>
export type RequestFingerprint = Brand<string, 'RequestFingerprint'>
export type PlanDigest = Brand<string, 'PlanDigest'>
export type ExecutionId = Brand<string, 'ExecutionId'>
export type TargetInstanceId = Brand<string, 'TargetInstanceId'>
export type PluginId = Brand<string, 'PluginId'>
export type ArtifactDigest = Brand<string, 'ArtifactDigest'>

export interface Evidence {
  readonly checkId: string
  readonly status: 'pass' | 'fail' | 'warn' | 'skip'
  readonly summary: string
  readonly observedAt: string
  readonly data?: JsonValue
}

export interface CapabilityRequirement {
  readonly id: string
  readonly portability: 'portable' | 'target-specific'
  readonly requirement: 'required' | 'optional'
  readonly version?: string
}

export interface PluginManifest {
  readonly schemaVersion: 1
  readonly id: PluginId
  readonly packageName: string
  readonly version: string
  readonly capabilities: readonly CapabilityRequirement[]
  readonly targets: Readonly<Record<string, JsonValue>>
}

export interface TargetInstance {
  readonly id: TargetInstanceId
  readonly target: string
  readonly version: string
  readonly root: string
  readonly metadata: JsonValue
  readonly capabilities: readonly CapabilityRequirement[]
}

export interface CompatibilityReport {
  readonly compatible: boolean
  readonly requiredSatisfied: boolean
  readonly evidence: readonly Evidence[]
}

export interface HealthReport {
  readonly healthy: boolean
  readonly evidence: readonly Evidence[]
}

export type InstallationState = 'absent' | 'staged' | 'installed' | 'unknown'
export type DesiredActivationState = 'active' | 'inactive'
export type ObservedActivationState = 'active' | 'inactive' | 'pending' | 'failed' | 'unknown'
export type TrustDecision = 'trusted' | 'untrusted' | 'prompt-required' | 'unknown'
export type UpdateState = 'current' | 'available' | 'blocked' | 'unknown'

export interface ExtensionStatus {
  readonly pluginId: PluginId
  readonly installation: InstallationState
  readonly desiredActivation: DesiredActivationState
  readonly observedActivation: ObservedActivationState
  readonly compatibility: CompatibilityReport
  readonly health: HealthReport
  readonly trust: TrustDecision
  readonly update: UpdateState
}

export interface ChangeRequest {
  readonly requestId: RequestId
  readonly targetInstanceId: TargetInstanceId
  readonly intent: JsonValue
}

export interface ChangePlan {
  readonly schemaVersion: 1
  readonly adapterId: string
  readonly targetInstanceId: TargetInstanceId
  readonly artifactDigest: ArtifactDigest
  readonly operations: readonly JsonValue[]
  readonly metadata: JsonValue
}

export interface TargetSnapshot {
  readonly ref: JsonValue
}

export interface TargetObservation {
  readonly value: JsonValue
}

export type TargetHealth =
  | { readonly ok: true; readonly evidence: readonly Evidence[] }
  | { readonly ok: false; readonly reason: string; readonly evidence: readonly Evidence[] }

export type RollbackVerification =
  | { readonly restored: true; readonly evidence: readonly Evidence[] }
  | { readonly restored: false; readonly reason: string; readonly evidence: readonly Evidence[] }

export interface TargetAdapter {
  readonly id: string
  plan(request: ChangeRequest): Promise<ChangePlan>
  validate(plan: ChangePlan): Promise<readonly Evidence[]>
  snapshot(plan: ChangePlan): Promise<TargetSnapshot>
  apply(plan: ChangePlan, executionId: ExecutionId): Promise<void>
  observe(plan: ChangePlan): Promise<TargetObservation>
  health(plan: ChangePlan, observation: TargetObservation): Promise<TargetHealth>
  rollback(snapshot: TargetSnapshot, executionId: ExecutionId): Promise<void>
  verifyRollback(snapshot: TargetSnapshot): Promise<RollbackVerification>
}

export interface DeepSyncLockEntry {
  readonly pluginId: PluginId
  readonly packageName: string
  readonly version: string
  readonly source: JsonValue
  readonly artifactDigest: ArtifactDigest
  readonly targetInstanceId: TargetInstanceId
  readonly planDigest: PlanDigest
  readonly evidence: readonly Evidence[]
}

export interface DeepSyncLockfile {
  readonly schemaVersion: 1
  readonly entries: readonly DeepSyncLockEntry[]
}

export interface DoctorCheck {
  readonly id: string
  readonly description: string
  run(): Promise<Evidence>
}

export interface ArtifactSource {
  readonly id: string
  resolve(reference: JsonValue): Promise<{ readonly location: string; readonly digest: ArtifactDigest; readonly evidence: readonly Evidence[] }>
}
