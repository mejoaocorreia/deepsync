import { describe, expect, it } from 'vitest'
import { nodeVersionCheck, readablePathCheck, runDoctor } from '../src/index.ts'

describe('deterministic doctor', () => {
  it('reports independent evidence and contains check failures', async () => {
    const report = await runDoctor([
      { id: 'pass', description: 'pass', async run() { return { checkId: 'pass', status: 'pass', summary: 'ok', observedAt: '2026-08-24T00:00:00Z' } } },
      { id: 'fail', description: 'fail', async run() { throw new Error('deterministic failure') } },
    ])
    expect(report.healthy).toBe(false)
    expect(report.evidence).toHaveLength(2)
    expect(report.evidence[1]).toMatchObject({ checkId: 'fail', status: 'fail', summary: 'deterministic failure' })
  })

  it('checks the current Node runtime and readable paths', async () => {
    const report = await runDoctor([nodeVersionCheck(22), readablePathCheck('cwd', process.cwd())])
    expect(report.healthy).toBe(true)
    expect(report.evidence.map(item => item.status)).toEqual(['pass', 'pass'])
  })
})
