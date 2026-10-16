import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { relaunchInPlace, SERVER_RESTART_EXIT_CODE, type RelaunchProcess } from './relaunch'

class Exited extends Error {
  constructor(readonly code: number) { super(`exit ${code}`) }
}

function fakeProcess(execve?: RelaunchProcess['execve']): RelaunchProcess & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    execPath: '/usr/local/bin/node',
    execArgv: ['--import', 'file:///repo/node_modules/tsx/dist/loader.mjs'],
    argv: ['/usr/local/bin/node', '/repo/src/server/index.ts', '--flag'],
    env: { HOME: '/Users/me' },
    ...(execve ? { execve: ((...args: Parameters<NonNullable<RelaunchProcess['execve']>>) => { calls.push(args); return execve(...args) }) } : {}),
    exit: (code) => { throw new Exited(code) },
  }
}

describe('relaunchInPlace', () => {
  it('replaces the process with the same node, flags, script and arguments', () => {
    const proc = fakeProcess(() => { throw new Exited(-1) })
    expect(() => relaunchInPlace(proc, () => {})).toThrow()
    expect(proc.calls).toEqual([[
      '/usr/local/bin/node',
      ['/usr/local/bin/node', '--import', 'file:///repo/node_modules/tsx/dist/loader.mjs', '/repo/src/server/index.ts', '--flag'],
      { HOME: '/Users/me' },
    ]])
  })

  it('falls back to the restart exit code where Node has no execve', () => {
    expect(() => relaunchInPlace(fakeProcess(), () => {})).toThrow(new Exited(SERVER_RESTART_EXIT_CODE))
  })

  it('falls back to the restart exit code when execve fails', () => {
    const log: string[] = []
    expect(() => relaunchInPlace(fakeProcess(() => { throw new Error('EACCES') }), (m) => log.push(m))).toThrow(new Exited(SERVER_RESTART_EXIT_CODE))
    expect(log.join('\n')).toContain('EACCES')
  })

  // The real thing, end to end: a script that relaunches itself must come
  // back as the same process and carry on, with no supervisor to help.
  it.runIf(typeof (process as { execve?: unknown }).execve === 'function')('comes back as the same process, unsupervised', () => {
    const script = `
      const { relaunchInPlace, realProcess } = require(${JSON.stringify(path.join(__dirname, 'relaunch.ts'))})
      const generation = Number(process.env.RELAUNCH_GENERATION ?? '0')
      console.log(generation + ' ' + process.pid)
      if (generation === 0) {
        process.env.RELAUNCH_GENERATION = '1'
        relaunchInPlace(realProcess(), () => {})
      }
    `
    const tsx = path.join(__dirname, '../../node_modules/tsx/dist/cli.mjs')
    const result = spawnSync(process.execPath, [tsx, '--eval', script], { encoding: 'utf8', env: { ...process.env, RELAUNCH_GENERATION: '0' } })
    expect(result.stderr).toBe('')
    const lines = result.stdout.trim().split('\n').map((line) => line.split(' '))
    expect(lines.map(([generation]) => generation)).toEqual(['0', '1'])
    expect(lines[0][1]).toBe(lines[1][1])
    expect(result.status).toBe(0)
  })
})
