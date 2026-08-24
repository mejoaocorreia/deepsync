export const EXTERNAL_PLUGIN_ID: 'third-party-readiness'
export const EXTERNAL_PACKAGE_NAME: '@third-party/deepsync-readiness-plugin'

export interface ExternalPluginFixtureOptions {
  readonly version?: string
  readonly outcome?: 'healthy' | 'unhealthy' | 'invalid-health' | 'activation-failure'
}

export function writeExternalPlugin(
  directory: string,
  options?: ExternalPluginFixtureOptions,
): Promise<{
  readonly directory: string
  readonly packageJson: Readonly<Record<string, unknown>>
  readonly manifest: Readonly<Record<string, unknown>>
  readonly outcome: string
}>
