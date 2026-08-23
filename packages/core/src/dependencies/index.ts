import { DeepSyncError } from '../errors/index.ts'

export interface DependencyNode {
  readonly id: string
  readonly dependencies: readonly string[]
}

export function orderDependencies(nodes: readonly DependencyNode[]): readonly string[] {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const result: string[] = []

  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new DeepSyncError('DEPENDENCY_CYCLE', `Dependency cycle includes ${id}`)
    const node = byId.get(id)
    if (node === undefined) throw new DeepSyncError('DEPENDENCY_MISSING', `Missing dependency ${id}`)
    visiting.add(id)
    for (const dependency of node.dependencies) visit(dependency)
    visiting.delete(id)
    visited.add(id)
    result.push(id)
  }

  for (const node of nodes) visit(node.id)
  return result
}
