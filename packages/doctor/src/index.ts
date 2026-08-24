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

export function nodeVersionCheck(minimumMajor = 22): DoctorCheck {
  return {
    id: 'runtime.node',
    description: 'Node.js satisfies the supported runtime range',
    async run() {
      const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
      return {
        checkId: 'runtime.node',
        status: major >= minimumMajor ? 'pass' : 'fail',
        summary: `Node.js ${process.versions.node}`,
        observedAt: new Date().toISOString(),
        data: { minimumMajor, observedMajor: major },
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
