import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import dshHealthResultSchema from '../schemas/dsh-health-result-v1.json' with { type: 'json' }
import dshTargetBindingSchema from '../schemas/dsh-target-binding-v1.json' with { type: 'json' }
import pluginManifestSchema from '../schemas/plugin-manifest-v1.json' with { type: 'json' }

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
export type ActivationAttemptId = Brand<string, 'ActivationAttemptId'>

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

export interface TargetBindingV1 {
  readonly schemaVersion: 1
  readonly target: string
}

export interface DshHealthDeclarationV1 {
  readonly schemaVersion: 1
  readonly protocol: 'deepsync.health/v1'
  readonly transport: 'json-file'
  readonly path: string
}

export interface DshTargetBindingV1 extends TargetBindingV1 {
  readonly target: 'dsh'
  readonly runtime: {
    readonly name: 'deepseek-harness'
    readonly version: string
    readonly node: string
  }
  readonly health: DshHealthDeclarationV1
}

export type PluginTargetBindingV1 = TargetBindingV1 | DshTargetBindingV1

export interface PluginManifestV1 {
  readonly schemaVersion: 1
  readonly id: PluginId
  readonly packageName: string
  readonly version: string
  readonly capabilities: readonly CapabilityRequirement[]
  readonly targets: Readonly<Record<string, PluginTargetBindingV1>>
}

export type PluginManifest = PluginManifestV1

export interface DshHealthResultV1 {
  readonly schemaVersion: 1
  readonly protocol: 'deepsync.health/v1'
  readonly pluginId: PluginId
  readonly pluginVersion: string
  readonly targetInstanceId: TargetInstanceId
  readonly activationAttemptId: ActivationAttemptId
  readonly status: 'healthy' | 'unhealthy'
  readonly observedAt: string
  readonly summary?: string
  readonly data?: JsonValue
}

export interface LocalPackageSourceReferenceV1 {
  readonly schemaVersion: 1
  readonly kind: 'local-package'
  readonly path: string
}

export interface LocalArtifactSourceReferenceV1 {
  readonly schemaVersion: 1
  readonly kind: 'local-artifact'
  readonly path: string
  readonly digest: ArtifactDigest
}

export interface GitHubReleaseSourceReferenceV1 {
  readonly schemaVersion: 1
  readonly kind: 'github-release'
  readonly owner: string
  readonly repository: string
  readonly tag: string
  readonly asset: string
  readonly digest: ArtifactDigest
}

export type ArtifactSourceReferenceV1 = LocalPackageSourceReferenceV1 | LocalArtifactSourceReferenceV1 | GitHubReleaseSourceReferenceV1

export interface PackedArtifactReferenceV1 {
  readonly schemaVersion: 1
  readonly kind: 'packed-artifact'
  readonly path: string
  readonly digest: ArtifactDigest
}

export interface DshAddIntentV1 {
  readonly schemaVersion: 1
  readonly adapterId: 'dsh'
  readonly action: 'add'
  readonly artifact: PackedArtifactReferenceV1
}

export type ValidationIssueCode =
  | 'INPUT_NOT_FOUND'
  | 'JSON_INVALID'
  | 'SCHEMA_REQUIRED'
  | 'SCHEMA_TYPE'
  | 'SCHEMA_CONST'
  | 'SCHEMA_ENUM'
  | 'SCHEMA_PATTERN'
  | 'SCHEMA_ADDITIONAL_PROPERTY'
  | 'SCHEMA_MIN_LENGTH'
  | 'SCHEMA_MIN_PROPERTIES'
  | 'SCHEMA_INVALID'
  | 'PACKAGE_IDENTITY_MISMATCH'
  | 'PACKAGE_ENTRYPOINT_MISSING'
  | 'PACKAGE_FILES_INVALID'
  | 'DSH_PACKAGE_METADATA_INVALID'
  | 'DSH_PATCH_INVALID'
  | 'DSH_RUNTIME_UNSUPPORTED'
  | 'ARTIFACT_ARCHIVE_UNSAFE'
  | 'ARTIFACT_DIGEST_MISMATCH'
  | 'HEALTH_CORRELATION_MISMATCH'
  | 'HEALTH_RESULT_STALE'

export interface ValidationIssue {
  readonly code: ValidationIssueCode
  readonly path: string
  readonly message: string
  readonly remediation: string
}

export type ValidationResult<Value> =
  | { readonly valid: true; readonly value: Value; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] }

export class ContractValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[], message = issues.map(issue => `${issue.path || '/'} ${issue.message}`).join('; ') || 'DeepSync contract validation failed') {
    super(message)
    this.name = 'ContractValidationError'
  }
}

export const PLUGIN_MANIFEST_SCHEMA_V1 = pluginManifestSchema
export const DSH_TARGET_BINDING_SCHEMA_V1 = dshTargetBindingSchema
export const DSH_HEALTH_RESULT_SCHEMA_V1 = dshHealthResultSchema

export const DSH_HEALTH_PROTOCOL_V1 = 'deepsync.health/v1'
export const DSH_HEALTH_ENV_V1 = {
  protocol: 'DEEPSYNC_HEALTH_PROTOCOL',
  resultPath: 'DEEPSYNC_HEALTH_RESULT_PATH',
  pluginId: 'DEEPSYNC_PLUGIN_ID',
  pluginVersion: 'DEEPSYNC_PLUGIN_VERSION',
  targetInstanceId: 'DEEPSYNC_TARGET_INSTANCE_ID',
  activationAttemptId: 'DEEPSYNC_ACTIVATION_ATTEMPT_ID',
} as const

const ajv = new Ajv2020({ allErrors: true, strict: true })
ajv.addSchema(DSH_TARGET_BINDING_SCHEMA_V1)
ajv.addSchema(DSH_HEALTH_RESULT_SCHEMA_V1)
const validatePluginManifestSchema = ajv.compile(PLUGIN_MANIFEST_SCHEMA_V1)
const validateDshTargetBindingSchema = ajv.getSchema(String(DSH_TARGET_BINDING_SCHEMA_V1.$id))!
const validateDshHealthResultSchema = ajv.getSchema(String(DSH_HEALTH_RESULT_SCHEMA_V1.$id))!

function issueCode(error: ErrorObject): ValidationIssueCode {
  if (error.keyword === 'required') return 'SCHEMA_REQUIRED'
  if (error.keyword === 'type') return 'SCHEMA_TYPE'
  if (error.keyword === 'const') return 'SCHEMA_CONST'
  if (error.keyword === 'enum') return 'SCHEMA_ENUM'
  if (error.keyword === 'pattern') return 'SCHEMA_PATTERN'
  if (error.keyword === 'additionalProperties') return 'SCHEMA_ADDITIONAL_PROPERTY'
  if (error.keyword === 'minLength') return 'SCHEMA_MIN_LENGTH'
  if (error.keyword === 'minProperties') return 'SCHEMA_MIN_PROPERTIES'
  return 'SCHEMA_INVALID'
}

function issuePath(error: ErrorObject): string {
  if (error.keyword === 'required') return `${error.instancePath}/${String(error.params.missingProperty)}`
  if (error.keyword === 'additionalProperties') return `${error.instancePath}/${String(error.params.additionalProperty)}`
  return error.instancePath
}

function remediation(error: ErrorObject, document: string): string {
  if (error.keyword === 'required') return `Add the required field to ${document}.`
  if (error.keyword === 'additionalProperties') return `Remove the unsupported field from ${document}.`
  if (error.keyword === 'const' || error.keyword === 'enum') return `Use one of the values allowed by the public ${document} schema.`
  if (error.keyword === 'pattern') return `Use the documented canonical format for this ${document} field.`
  return `Conform this value to the public ${document} schema.`
}

function validateDocument<Value>(validate: ValidateFunction, input: unknown, document: string): ValidationResult<Value> {
  if (validate(input)) return { valid: true, value: input as Value, issues: [] }
  const issues = (validate.errors ?? []).map(error => ({
    code: issueCode(error),
    path: issuePath(error),
    message: error.keyword === 'minLength' ? `${document} field is required` : error.message === undefined ? `Invalid ${document}` : `${document} ${error.message}`,
    remediation: remediation(error, document),
  }))
  return { valid: false, issues }
}

export function validatePluginManifestDocument(input: unknown): ValidationResult<PluginManifestV1> {
  return validateDocument(validatePluginManifestSchema, input, 'plugin manifest')
}

export function validateDshTargetBindingDocument(input: unknown): ValidationResult<DshTargetBindingV1> {
  return validateDocument(validateDshTargetBindingSchema, input, 'DSH target binding')
}

export function validateDshHealthResultDocument(input: unknown): ValidationResult<DshHealthResultV1> {
  return validateDocument(validateDshHealthResultSchema, input, 'DSH health result')
}

export function assertPluginManifestDocument(input: unknown): PluginManifestV1 {
  const result = validatePluginManifestDocument(input)
  if (!result.valid) throw new ContractValidationError(result.issues)
  return result.value
}

export function assertDshTargetBindingDocument(input: unknown): DshTargetBindingV1 {
  const result = validateDshTargetBindingDocument(input)
  if (!result.valid) throw new ContractValidationError(result.issues)
  return result.value
}

export function assertDshHealthResultDocument(input: unknown): DshHealthResultV1 {
  const result = validateDshHealthResultDocument(input)
  if (!result.valid) throw new ContractValidationError(result.issues)
  return result.value
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
