import { describe, it, expect } from 'vitest'
import {
  parseSessionRegistryRecord,
  pidFromFileName,
  readSessionRegistry,
  type SessionRegistryDeps
} from './session-registry'

/** A registry populated from literals — no ~/.claude/sessions on disk. */
function fakeRegistry(
  files: Record<string, string>,
  alivePids: number[] = Object.keys(files).map((f) => Number.parseInt(f, 10))
): SessionRegistryDeps {
  return {
    listPidFiles: () => Object.keys(files),
    readPidFile: (name) => files[name] ?? null,
    pidAlive: (pid) => alivePids.includes(pid)
  }
}

const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 1000, kind: 'interactive', ...over })

describe('pidFromFileName', () => {
  it('accepts a canonical pid file name', () => {
    expect(pidFromFileName('36554.json')).toBe(36554)
  })

  it('rejects names that do not round-trip to their pid', () => {
    // Not files this registry wrote; accepting them would invent records.
    expect(pidFromFileName('0012.json')).toBeNull()
    expect(pidFromFileName('12x.json')).toBeNull()
    expect(pidFromFileName('notapid.json')).toBeNull()
    expect(pidFromFileName('1.json')).toBeNull()
  })
})

describe('parseSessionRegistryRecord', () => {
  it('reads the fields we care about', () => {
    const parsed = parseSessionRegistryRecord('100.json', record({ procStart: 'Tue Sep 8 16:08:47 2026' }))
    expect(parsed).toEqual({
      pid: 100,
      claudeSessionId: 'sess-a',
      status: 'busy',
      statusUpdatedAt: 1000,
      kind: 'interactive',
      procStart: 'Tue Sep 8 16:08:47 2026'
    })
  })

  it('keeps waitingFor, which is the reason a waiting session is waiting', () => {
    const parsed = parseSessionRegistryRecord('100.json', record({ status: 'waiting', waitingFor: 'dialog open' }))
    expect(parsed?.status).toBe('waiting')
    expect(parsed?.waitingFor).toBe('dialog open')
  })

  it('drops an unrecognised status rather than passing it through', () => {
    // A status added by a future Claude Code must read as "no opinion", never as
    // one we would guess the meaning of.
    const parsed = parseSessionRegistryRecord('100.json', record({ status: 'compacting' }))
    expect(parsed).not.toBeNull()
    expect(parsed?.status).toBeUndefined()
  })

  it('returns null for a torn or non-JSON body', () => {
    // The writer is not known to be atomic, so a half-written file is possible.
    expect(parseSessionRegistryRecord('100.json', '{"pid":100,"sess')).toBeNull()
    expect(parseSessionRegistryRecord('100.json', 'null')).toBeNull()
  })

  it('returns null without a session id, since there is no surface to join', () => {
    expect(parseSessionRegistryRecord('100.json', JSON.stringify({ pid: 100, status: 'busy' }))).toBeNull()
  })
})

describe('readSessionRegistry', () => {
  it('indexes live records by claude session id', () => {
    const registry = readSessionRegistry(
      fakeRegistry({
        '100.json': record(),
        '200.json': record({ pid: 200, sessionId: 'sess-b', status: 'idle' })
      })
    )
    expect([...registry.keys()]).toEqual(['sess-a', 'sess-b'])
    expect(registry.get('sess-b' as never)?.status).toBe('idle')
  })

  it('drops records whose process is gone', () => {
    // The registry cleans up on exit, but a SIGKILLed session leaves its last
    // status behind — and a stale 'busy' is the reading that would mislead.
    const registry = readSessionRegistry(
      fakeRegistry({ '100.json': record(), '200.json': record({ pid: 200, sessionId: 'sess-b' }) }, [100])
    )
    expect([...registry.keys()]).toEqual(['sess-a'])
  })

  it('survives a file that vanishes between listing and reading', () => {
    const deps: SessionRegistryDeps = {
      listPidFiles: () => ['100.json', '200.json'],
      readPidFile: (name) => (name === '100.json' ? record() : null),
      pidAlive: () => true
    }
    expect([...readSessionRegistry(deps).keys()]).toEqual(['sess-a'])
  })

  it('is empty when the directory does not exist', () => {
    const deps: SessionRegistryDeps = { listPidFiles: () => [], readPidFile: () => null, pidAlive: () => true }
    expect(readSessionRegistry(deps).size).toBe(0)
  })
})
