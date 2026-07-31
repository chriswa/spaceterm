import { describe, expect, it } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { expandTilde } from './cwd'

/**
 * expandTilde is the single expansion point for agent working directories.
 * Claude inherits the PTY cwd while Cursor (--workspace) and Codex (-C) take it
 * as argv, and shell tilde-expansion runs for neither — so an unexpanded `~`
 * reaches the agent literally and it exits with "directory does not exist".
 */
describe('expandTilde', () => {
  it('expands a bare tilde to the home directory', () => {
    expect(expandTilde('~')).toBe(homedir())
  })

  it('expands a tilde-slash path', () => {
    expect(expandTilde('~/spaceterm')).toBe(join(homedir(), 'spaceterm'))
  })

  it('expands a nested tilde path', () => {
    expect(expandTilde('~/a/b/c')).toBe(join(homedir(), 'a/b/c'))
  })

  it('leaves an absolute path unchanged', () => {
    expect(expandTilde('/usr/local')).toBe('/usr/local')
  })

  it('leaves a relative path unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path')
  })

  it('passes undefined through', () => {
    expect(expandTilde(undefined)).toBeUndefined()
  })

  it('passes an empty string through', () => {
    // Falsy, so it short-circuits — an empty cwd stays empty rather than
    // silently becoming the home directory.
    expect(expandTilde('')).toBe('')
  })

  it('does not expand a tilde that is not the first character', () => {
    expect(expandTilde('/tmp/~/x')).toBe('/tmp/~/x')
  })

  it('does not expand a username tilde', () => {
    // `~other` means another user's home; we only handle the current user's,
    // and mangling it into `<home>other` would be worse than leaving it.
    expect(expandTilde('~other/dir')).toBe('~other/dir')
  })

  it('does not expand a tilde-prefixed relative name', () => {
    expect(expandTilde('~backup')).toBe('~backup')
  })
})
