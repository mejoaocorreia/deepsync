import type { TargetAdapter } from '@deepsync/contracts'

export interface DeepSyncCoreOptions {
  readonly adapters?: readonly TargetAdapter[]
}

export class DeepSyncCore {
  readonly #adapters: ReadonlyMap<string, TargetAdapter>

  constructor(options: DeepSyncCoreOptions = {}) {
    this.#adapters = new Map((options.adapters ?? []).map(adapter => [adapter.id, adapter]))
  }

  listAdapters(): readonly string[] {
    return [...this.#adapters.keys()].sort()
  }

  adapter(id: string): TargetAdapter | undefined {
    return this.#adapters.get(id)
  }
}

export type * from '@deepsync/contracts'
