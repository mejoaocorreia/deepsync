import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivationAttemptId, PluginId, TargetInstanceId } from '@deepsync/contracts'
import { describe, expect, it } from 'vitest'
import { activateAndCheck, type DshHealthExpectationV1, type IsolatedDshInstance } from '../src/index.ts'

const script = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const mode = process.argv[2];
if (mode === 'exit') process.exit(3);
const file = process.env.DEEPSYNC_HEALTH_RESULT_PATH;
mkdirSync(dirname(file), { recursive: true });
if (mode === 'json') writeFileSync(file, '{bad');
else writeFileSync(file, JSON.stringify({
  schemaVersion: 1,
  protocol: 'deepsync.health/v1',
  pluginId: 'external-plugin',
  pluginVersion: mode === 'mismatch' ? '0.0.1' : '1.0.0',
  targetInstanceId: process.env.DEEPSYNC_TARGET_INSTANCE_ID,
  activationAttemptId: process.env.DEEPSYNC_ACTIVATION_ATTEMPT_ID,
  status: mode === 'unhealthy' ? 'unhealthy' : 'healthy',
  observedAt: new Date().toISOString(),
}));
setInterval(() => {}, 1000);
`

async function setup(mode: string): Promise<{ root: string; instance: IsolatedDshInstance; expectation: DshHealthExpectationV1 }> {
  const root = await mkdtemp(join(tmpdir(), 'deepsync-health-'))
  await mkdir(join(root, '.tmp'))
  const scriptPath = join(root, 'plugin.mjs')
  await writeFile(scriptPath, script)
  return {
    root,
    instance: { command: { command: process.execPath, prefixArgs: [scriptPath, mode], cwd: root }, home: root, profile: 'deepsync-test', instanceNonce: 'nonce-for-health-test' },
    expectation: {
      pluginId: 'external-plugin' as PluginId,
      pluginVersion: '1.0.0',
      targetInstanceId: 'dsh:external' as TargetInstanceId,
      activationAttemptId: 'attempt-1' as ActivationAttemptId,
      declaration: { schemaVersion: 1, protocol: 'deepsync.health/v1', transport: 'json-file', path: 'health/result.json' },
    },
  }
}

describe('generic DSH health protocol', () => {
  it.each([
    ['healthy', true, ['pass', 'pass']],
    ['unhealthy', false, ['pass', 'fail']],
    ['mismatch', false, ['pass', 'fail']],
    ['json', false, ['pass', 'fail']],
    ['exit', false, ['fail', 'skip']],
  ] as const)('keeps loader observation and %s health evidence distinct', async (mode, ok, statuses) => {
    const context = await setup(mode)
    try {
      const result = await activateAndCheck(context.instance, context.expectation, 3_000)
      expect(result.ok).toBe(ok)
      expect(result.evidence.map(item => item.checkId)).toEqual(['dsh.loader-observation', 'plugin.health.v1'])
      expect(result.evidence.map(item => item.status)).toEqual(statuses)
    } finally {
      await rm(context.root, { recursive: true, force: true })
    }
  }, 10_000)
})
