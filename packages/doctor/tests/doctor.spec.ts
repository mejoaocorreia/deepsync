import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/index.ts'

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
})
