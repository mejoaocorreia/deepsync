import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const EXTERNAL_PLUGIN_ID = 'third-party-readiness'
export const EXTERNAL_PACKAGE_NAME = '@third-party/deepsync-readiness-plugin'

export async function writeExternalPlugin(directory, options = {}) {
  const version = options.version ?? '1.0.0'
  const outcome = options.outcome ?? 'healthy'
  await mkdir(directory, { recursive: true })
  const packageJson = {
    name: EXTERNAL_PACKAGE_NAME,
    version,
    type: 'module',
    license: 'MIT',
    main: './index.js',
    files: ['index.js', 'cordis.patch.yml', 'deepsync.manifest.json'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  const manifest = {
    schemaVersion: 1,
    id: EXTERNAL_PLUGIN_ID,
    packageName: EXTERNAL_PACKAGE_NAME,
    version,
    capabilities: [{ id: 'dsh.profile.bundle', portability: 'target-specific', requirement: 'required', version: '0.1.1-rc.2' }],
    targets: {
      dsh: {
        schemaVersion: 1,
        target: 'dsh',
        runtime: { name: 'deepseek-harness', version: '0.1.1-rc.2', node: '^22.19.0 || >=24.0.0' },
        health: { schemaVersion: 1, protocol: 'deepsync.health/v1', transport: 'json-file', path: 'third-party-readiness-health.json' },
      },
    },
  }
  const entrypoint = `
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const pluginId = ${JSON.stringify(EXTERNAL_PLUGIN_ID)};
const pluginVersion = ${JSON.stringify(version)};
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('Missing ' + name);
  return value;
}
export function apply(ctx, config = {}) {
  if (config.outcome === 'activation-failure') throw new Error('Third-party activation failed');
  if (required('DEEPSYNC_HEALTH_PROTOCOL') !== 'deepsync.health/v1') throw new Error('Unsupported health protocol');
  const filename = required('DEEPSYNC_HEALTH_RESULT_PATH');
  const result = {
    schemaVersion: 1,
    protocol: 'deepsync.health/v1',
    pluginId,
    pluginVersion,
    targetInstanceId: required('DEEPSYNC_TARGET_INSTANCE_ID'),
    activationAttemptId: config.outcome === 'invalid-health' ? 'wrong-attempt' : required('DEEPSYNC_ACTIVATION_ATTEMPT_ID'),
    status: config.outcome === 'unhealthy' ? 'unhealthy' : 'healthy',
    observedAt: new Date().toISOString(),
    summary: config.outcome === 'unhealthy' ? 'Third-party readiness check failed' : 'Third-party plugin is ready',
  };
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, JSON.stringify(result) + '\\n', { encoding: 'utf8', mode: 0o600 });
  ctx.effect(() => () => rmSync(filename, { force: true }));
}
`
  await Promise.all([
    writeFile(join(directory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(join(directory, 'deepsync.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(directory, 'index.js'), entrypoint.trimStart()),
    writeFile(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: third-party-readiness\n      name: '${EXTERNAL_PACKAGE_NAME}'\n      config:\n        outcome: ${outcome}\n`),
  ])
  return { directory, packageJson, manifest, outcome }
}
