import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'deepsync-lifecycle-probe'

export function apply(ctx, config = {}) {
  const mode = config.mode ?? 'healthy'
  if (mode === 'activation-failure') throw new Error('DeepSync fixture activation failure')
  const home = process.env.DSH_HOME
  if (!home) throw new Error('DeepSync fixture requires DSH_HOME')
  const filename = join(home, 'deepsync-probe-health.json')
  mkdirSync(dirname(filename), { recursive: true })
  writeFileSync(filename, `${JSON.stringify({ healthy: mode !== 'health-failure', mode })}\n`, { encoding: 'utf8', mode: 0o600 })
  ctx.effect(() => () => rmSync(filename, { force: true }))
}
