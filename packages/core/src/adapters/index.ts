import type { TargetAdapter } from '@deepsync/contracts'

export class AdapterRegistry {
  readonly #adapters = new Map<string, TargetAdapter>()

  constructor(adapters: readonly TargetAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: TargetAdapter): () => void {
    if (this.#adapters.has(adapter.id)) throw new Error(`Adapter ${adapter.id} is already registered`)
    this.#adapters.set(adapter.id, adapter)
    return () => { this.#adapters.delete(adapter.id) }
  }

  get(id: string): TargetAdapter | undefined {
    return this.#adapters.get(id)
  }

  list(): readonly string[] {
    return [...this.#adapters.keys()].sort()
  }
}
