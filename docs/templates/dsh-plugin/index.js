import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const pluginId = 'example-ready'
const pluginVersion = '1.0.0'

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

export function apply(ctx) {
  if (required('DEEPSYNC_HEALTH_PROTOCOL') !== 'deepsync.health/v1') throw new Error('Unsupported DeepSync health protocol')
  const filename = required('DEEPSYNC_HEALTH_RESULT_PATH')
  const result = {
    schemaVersion: 1,
    protocol: 'deepsync.health/v1',
    pluginId,
    pluginVersion,
    targetInstanceId: required('DEEPSYNC_TARGET_INSTANCE_ID'),
    activationAttemptId: required('DEEPSYNC_ACTIVATION_ATTEMPT_ID'),
    status: 'healthy',
    observedAt: new Date().toISOString(),
    summary: 'Example plugin is ready',
  }
  mkdirSync(dirname(filename), { recursive: true })
  writeFileSync(filename, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 })
  ctx.effect(() => () => rmSync(filename, { force: true }))
}
