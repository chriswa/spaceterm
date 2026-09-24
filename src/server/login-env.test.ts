import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LoginShellEnv, parseCapturedEnv } from './login-env'
import { serverLog } from './server-log'

vi.mock('./server-log', () => ({ serverLog: vi.fn() }))

const MARKER = '__SPACETERM_LOGIN_ENV__'

describe('parseCapturedEnv', () => {
  it('reads NUL-separated variables after the marker', () => {
    expect(parseCapturedEnv(`\0${MARKER}\0A=1\0B=two words\0`)).toEqual({ A: '1', B: 'two words' })
  })

  it('ignores whatever the rc files printed before the marker', () => {
    expect(parseCapturedEnv(`Now using node v22\nFAKE=1\0\0${MARKER}\0A=1\0`)).toEqual({ A: '1' })
  })

  it('keeps values containing = and newlines intact', () => {
    expect(parseCapturedEnv(`\0${MARKER}\0URL=a=b\0MULTI=x\ny\0`)).toEqual({ URL: 'a=b', MULTI: 'x\ny' })
  })

  it('drops variables the capturing shell sets for itself', () => {
    expect(parseCapturedEnv(`\0${MARKER}\0PWD=/h\0OLDPWD=/\0SHLVL=2\0_=/usr/bin/env\0A=1\0`)).toEqual({ A: '1' })
  })

  it('returns null when the marker is missing', () => {
    expect(parseCapturedEnv('A=1\0B=2\0')).toBeNull()
  })
})

describe('LoginShellEnv', () => {
  let dir: string | undefined
  let env: LoginShellEnv | undefined

  afterEach(() => {
    env?.dispose()
    env = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
    vi.unstubAllEnvs()
    vi.mocked(serverLog).mockClear()
  })

  /** A stand-in for `$SHELL` that records its argv and prints a capture. */
  function fakeShell(body: string): string {
    dir = mkdtempSync(join(tmpdir(), 'login-env-'))
    const path = join(dir, 'zsh')
    writeFileSync(path, `#!/bin/sh\necho "$@" > "${dir}/argv"\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('is null until the first capture lands, then returns it', async () => {
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'login-env-home-')))
    const shell = fakeShell(`printf 'banner\\n\\0${MARKER}\\0FRESH=yes\\0'`)
    env = new LoginShellEnv(shell)
    expect(env.current()).toBeNull()
    await vi.waitFor(() => expect(env!.current()).toEqual({ FRESH: 'yes' }))
    expect(readFileSync(join(dir!, 'argv'), 'utf8')).toMatch(/^-l -i -c /)
  })

  it('keeps the previous capture when a later one fails', async () => {
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'login-env-home-')))
    const flag = join(tmpdir(), `login-env-fail-${process.pid}-${Date.now()}`)
    const shell = fakeShell(
      `if [ -e "${flag}" ]; then exit 1; fi; printf '\\0${MARKER}\\0FRESH=yes\\0'`
    )
    env = new LoginShellEnv(shell)
    await vi.waitFor(() => expect(env!.current()).toEqual({ FRESH: 'yes' }))
    writeFileSync(flag, '')
    try {
      env.refresh()
      await vi.waitFor(() => expect(serverLog).toHaveBeenCalledWith(expect.stringContaining('[login-env] capture')))
      expect(env.current()).toEqual({ FRESH: 'yes' })
    } finally {
      rmSync(flag, { force: true })
    }
  })
})
