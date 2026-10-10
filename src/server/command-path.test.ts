import { describe, expect, it } from 'vitest'
import { resolveOnPath } from './command-path'

const only = (...files: string[]) => (file: string) => files.includes(file)

describe('resolveOnPath', () => {
  it('takes the first PATH entry that holds the command', () => {
    const exe = only('/home/u/.local/bin/claude', '/opt/homebrew/bin/claude')
    expect(resolveOnPath('claude', '/usr/bin:/home/u/.local/bin:/opt/homebrew/bin', exe))
      .toBe('/home/u/.local/bin/claude')
  })

  it('leaves a command it cannot find bare, for the daemon to look up itself', () => {
    expect(resolveOnPath('claude', '/usr/bin:/bin', only())).toBe('claude')
  })

  it('leaves a command with a slash alone', () => {
    expect(resolveOnPath('/bin/sh', '/opt/homebrew/bin', () => true)).toBe('/bin/sh')
  })

  it('leaves the command bare when there is no PATH', () => {
    expect(resolveOnPath('claude', undefined, () => true)).toBe('claude')
  })

  it('never resolves against the current directory via an empty PATH entry', () => {
    expect(resolveOnPath('claude', ':/usr/bin', (f) => !f.startsWith('/usr/'))).toBe('claude')
  })
})
