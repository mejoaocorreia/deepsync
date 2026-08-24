import { access } from 'node:fs/promises'
import type { DoctorCheck, Evidence } from '@deepsync/contracts'

export interface DoctorReport {
  readonly healthy: boolean
  readonly evidence: readonly Evidence[]
}

export async function runDoctor(checks: readonly DoctorCheck[]): Promise<DoctorReport> {
  const evidence: Evidence[] = []
  for (const check of checks) {
    try {
      evidence.push(await check.run())
    } catch (error) {
      evidence.push({
        checkId: check.id,
        status: 'fail',
        summary: error instanceof Error ? error.message : String(error),
        observedAt: new Date().toISOString(),
      })
    }
  }
  return { healthy: evidence.every(item => item.status !== 'fail'), evidence }
}

export function nodeVersionCheck(version = process.versions.node): DoctorCheck {
  return {
    id: 'runtime.node',
    description: 'Node.js satisfies ^22.19.0 or >=24.0.0',
    async run() {
      const [major = 0, minor = 0] = version.split('.').map(part => Number.parseInt(part, 10))
      const supported = (major === 22 && minor >= 19) || major >= 24
      return {
        checkId: 'runtime.node',
        status: supported ? 'pass' : 'fail',
        summary: `Node.js ${version}`,
        observedAt: new Date().toISOString(),
        data: { expected: '^22.19.0 || >=24.0.0', observed: version },
      }
    },
  }
}

export function readablePathCheck(id: string, path: string): DoctorCheck {
  return {
    id,
    description: `Path ${path} is readable`,
    async run(): Promise<Evidence> {
      await access(path)
      return { checkId: id, status: 'pass', summary: `Readable: ${path}`, observedAt: new Date().toISOString() }
    },
  }
}

export function evidenceCheck(evidence: Evidence): DoctorCheck {
  return { id: evidence.checkId, description: evidence.summary, async run() { return evidence } }
}
