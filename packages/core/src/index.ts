import type { TargetAdapter } from '@deepsync/contracts'
import { AdapterRegistry } from './adapters/index.ts'

export interface DeepSyncCoreOptions {
  readonly adapters?: readonly TargetAdapter[]
}

export class DeepSyncCore {
  readonly #adapters: AdapterRegistry

  constructor(options: DeepSyncCoreOptions = {}) {
    this.#adapters = new AdapterRegistry(options.adapters)
  }

  listAdapters(): readonly string[] {
    return this.#adapters.list()
  }

  adapter(id: string): TargetAdapter | undefined {
    return this.#adapters.get(id)
  }
}

export * from './adapters/index.ts'
export * from './capabilities/index.ts'
export * from './compatibility/index.ts'
export * from './dependencies/index.ts'
export * from './errors/index.ts'
export * from './health/index.ts'
export * from './lockfile/index.ts'
export * from './plugins/index.ts'
export * from './resolver/index.ts'
export * from './state/index.ts'
export * from './targets/index.ts'
export * from './transactions/index.ts'
export type * from '@deepsync/contracts'
