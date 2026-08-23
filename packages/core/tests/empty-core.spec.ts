import { describe, expect, it } from 'vitest'
import { DeepSyncCore } from '../src/index.ts'

describe('DeepSyncCore', () => {
  it('starts headless with no adapters or plugins', () => {
    const core = new DeepSyncCore()
    expect(core.listAdapters()).toEqual([])
    expect(core.adapter('dsh')).toBeUndefined()
  })
})
