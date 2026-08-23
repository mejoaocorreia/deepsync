import type { TargetInstance } from '@deepsync/contracts'

export class TargetRegistry {
  readonly #instances = new Map<string, TargetInstance>()

  register(instance: TargetInstance): () => void {
    if (this.#instances.has(instance.id)) throw new Error(`Target instance ${instance.id} is already registered`)
    this.#instances.set(instance.id, instance)
    return () => { this.#instances.delete(instance.id) }
  }

  list(): readonly TargetInstance[] {
    return [...this.#instances.values()]
  }
}
