import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'deepsync-lifecycle-probe'

const pluginId = 'dsh-lifecycle-probe'
const pluginVersion = '0.1.0-alpha.3'

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`DeepSync health protocol requires ${name}`)
  return value
}

export function apply(ctx, config = {}) {
  const mode = config.mode ?? 'healthy'
  if (mode === 'activation-failure') throw new Error('Lifecycle fixture activation failure')
  if (required('DEEPSYNC_HEALTH_PROTOCOL') !== 'deepsync.health/v1') throw new Error('Unsupported DeepSync health protocol')
  const filename = required('DEEPSYNC_HEALTH_RESULT_PATH')
  const result = {
    schemaVersion: 1,
    protocol: 'deepsync.health/v1',
    pluginId,
    pluginVersion,
    targetInstanceId: required('DEEPSYNC_TARGET_INSTANCE_ID'),
    activationAttemptId: required('DEEPSYNC_ACTIVATION_ATTEMPT_ID'),
    status: mode === 'health-failure' ? 'unhealthy' : 'healthy',
    observedAt: new Date().toISOString(),
    summary: mode === 'health-failure' ? 'Lifecycle fixture requested an unhealthy result' : 'Lifecycle fixture is ready',
  }
  mkdirSync(dirname(filename), { recursive: true })
  writeFileSync(filename, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 })
  ctx.effect(() => () => rmSync(filename, { force: true }))
}
