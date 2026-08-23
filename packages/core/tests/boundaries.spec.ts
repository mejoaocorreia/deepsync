import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

async function files(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else if (entry.name.endsWith('.ts')) result.push(path)
  }
  return result
}

describe('Core dependency boundary', () => {
  it('does not import target, product, UI, network-source, or runtime packages', async () => {
    const forbidden = [/deepseek/iu, /cortex/iu, /cordis/iu, /modelcontextprotocol/iu, /react/iu, /source-github/iu]
    for (const path of await files(join(import.meta.dirname, '..', 'src'))) {
      const code = await readFile(path, 'utf8')
      for (const pattern of forbidden) expect(code, path).not.toMatch(pattern)
    }
  })
})
