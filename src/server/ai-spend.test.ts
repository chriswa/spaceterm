import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { aiSpendRunner } from './ai-spend'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** An `ai-spend` on a PATH of its own, running `body`. */
function fakeAiSpend(body: string): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'ai-spend-'))
  dirs.push(dir)
  const file = join(dir, 'ai-spend')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return { PATH: `${dir}:/usr/bin:/bin` }
}

describe('aiSpendRunner', () => {
  it('finds ai-spend on the PATH it is given and resolves with its JSON', async () => {
    const env = fakeAiSpend(`echo '{"omittedAccounts":["Claude: Spare"],"providers":[]}'`)
    expect(await aiSpendRunner(() => env)()).toBe('{"omittedAccounts":["Claude: Spare"],"providers":[]}')
  })

  it('rejects with what ai-spend said when it fails, or when it prints something other than JSON', async () => {
    await expect(aiSpendRunner(() => fakeAiSpend('echo "ai-spend: AI Spend Tracker.app not found" >&2; exit 1'))())
      .rejects.toThrow('ai-spend: AI Spend Tracker.app not found')
    await expect(aiSpendRunner(() => fakeAiSpend('echo hello'))()).rejects.toThrow('ai-spend printed something other than JSON')
  })

  it('rejects when ai-spend is not on the PATH', async () => {
    await expect(aiSpendRunner(() => ({ PATH: '/nonexistent' }))()).rejects.toThrow('could not run ai-spend')
  })
})
