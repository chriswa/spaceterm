import { describe, expect, it } from 'vitest'
import { HandsFreePresence, VoiceOperatorHandsFree, handsFreeAction, type VoiceOperatorHandsFreeDeps } from './voice-operator-hands-free'

/** Voice Operator's hands-free socket, as connections opened to it and what they wrote. */
function fakeVoiceOperator(pid: number | null = 42) {
  const connections: Array<{ path: string; written: Array<Record<string, unknown>>; say(m: Record<string, unknown>): void; drop(): void; closed: boolean }> = []
  let discovery: { pid?: unknown; hands_free_socket?: unknown } | undefined = pid === null ? undefined : { pid, hands_free_socket: '/tmp/vo.sock' }
  const deps: VoiceOperatorHandsFreeDeps = {
    readDiscovery: () => discovery,
    connect: (path, onLine, onClose) => {
      const c = {
        path, written: [] as Array<Record<string, unknown>>, closed: false,
        say: (m: Record<string, unknown>) => onLine(JSON.stringify(m)),
        drop: () => { if (!c.closed) { c.closed = true; onClose() } },
      }
      connections.push(c)
      return { write: (line) => c.written.push(JSON.parse(line) as Record<string, unknown>), close: () => c.drop() }
    },
    log: () => {},
  }
  return { deps, connections, restart: (next: number) => { discovery = { pid: next, hands_free_socket: '/tmp/vo.sock' } }, stop: () => { discovery = undefined } }
}

describe('VoiceOperatorHandsFree', () => {
  it('registers "control" on a held connection, once per Voice Operator process', () => {
    const vo = fakeVoiceOperator()
    const link = new VoiceOperatorHandsFree(vo.deps, () => {}, true)
    link.setClientsPresent(true)
    link.check()
    expect(vo.connections).toHaveLength(1)
    expect(vo.connections[0].written).toEqual([{ type: 'hello', protocol: 1, client: 'spaceterm', trigger: 'control' }])
    vo.connections[0].say({ type: 'welcome', protocol: 1 })
    expect(link.ready).toBe(true)
    vo.restart(43)
    link.check()
    expect(vo.connections).toHaveLength(2)
    expect(vo.connections[0].closed).toBe(true)
  })

  it('does not claim the trigger word from an isolated home', () => {
    const vo = fakeVoiceOperator()
    const events: unknown[] = []
    const link = new VoiceOperatorHandsFree(vo.deps, (e) => events.push(e), false)
    link.setClientsPresent(true)
    expect(vo.connections).toEqual([])
    link.setMac(true)
    expect(events).toEqual([{ type: 'session-ended', why: 'not-operator-home' }])
  })

  it('turns the Mac on once registered — again after Voice Operator comes back — and hands on what it says', () => {
    const vo = fakeVoiceOperator()
    const events: Array<Record<string, unknown>> = []
    const link = new VoiceOperatorHandsFree(vo.deps, (e) => events.push(e), true)
    link.setClientsPresent(true)
    vo.connections[0].say({ type: 'welcome', protocol: 1 })
    link.setMac(true)
    expect(vo.connections[0].written.at(-1)).toEqual({ type: 'start', source: 'mac' })
    vo.connections[0].say({ type: 'state', phase: 'listening' })
    expect(events).toEqual([{ type: 'state', phase: 'listening' }])
    // Voice Operator restarts: the session is gone, and comes back with it.
    vo.connections[0].drop()
    expect(events.at(-1)).toEqual({ type: 'session-ended', why: 'disconnected' })
    vo.restart(43)
    link.check()
    vo.connections[1].say({ type: 'welcome', protocol: 1 })
    expect(vo.connections[1].written.at(-1)).toEqual({ type: 'start', source: 'mac' })
    link.setMac(false)
    expect(vo.connections[1].written.at(-1)).toEqual({ type: 'stop' })
  })

  it('starts the Mac again when Voice Operator comes back from a restart, but not after the user turned it off', () => {
    const vo = fakeVoiceOperator()
    const link = new VoiceOperatorHandsFree(vo.deps, () => {}, true)
    link.setClientsPresent(true)
    vo.connections[0].say({ type: 'welcome', protocol: 1 })
    link.setMac(true)
    vo.connections[0].say({ type: 'session-ended', why: 'restarting' })
    vo.connections[0].drop()
    vo.restart(43)
    link.check()
    vo.connections[1].say({ type: 'welcome', protocol: 1 })
    expect(vo.connections[1].written.at(-1)).toEqual({ type: 'start', source: 'mac' })
    // Said by voice: off for good.
    vo.connections[1].say({ type: 'session-ended', why: 'shutdown' })
    vo.connections[1].drop()
    vo.restart(44)
    link.check()
    vo.connections[2].say({ type: 'welcome', protocol: 1 })
    expect(vo.connections[2].written).toEqual([{ type: 'hello', protocol: 1, client: 'spaceterm', trigger: 'control' }])
  })

  it('registers only while a client is connected, and turns the Mac on again when one is back', () => {
    const vo = fakeVoiceOperator()
    const link = new VoiceOperatorHandsFree(vo.deps, () => {}, true)
    link.check()
    expect(vo.connections).toEqual([])
    link.setClientsPresent(true)
    vo.connections[0].say({ type: 'welcome', protocol: 1 })
    link.setMac(true)
    link.setClientsPresent(false)
    expect(vo.connections[0].closed).toBe(true)
    expect(link.ready).toBe(false)
    link.check()
    expect(vo.connections).toHaveLength(1)
    link.setClientsPresent(true)
    vo.connections[1].say({ type: 'welcome', protocol: 1 })
    expect(vo.connections[1].written.at(-1)).toEqual({ type: 'start', source: 'mac' })
  })

  it('hands on each of Voice Operator\'s messages once, however many clients are connected', () => {
    const vo = fakeVoiceOperator()
    const events: Array<Record<string, unknown>> = []
    const link = new VoiceOperatorHandsFree(vo.deps, (e) => events.push(e), true)
    link.setClientsPresent(true)
    link.setClientsPresent(true)
    expect(vo.connections).toHaveLength(1)
    vo.connections[0].say({ type: 'welcome', protocol: 1 })
    link.setMac(true)
    vo.connections[0].say({ type: 'transcript', text: 'Control, yeah, next.' })
    expect(events).toEqual([{ type: 'transcript', text: 'Control, yeah, next.' }])
  })

  it('opens a phone\'s stream as a connection of its own', () => {
    const vo = fakeVoiceOperator()
    const link = new VoiceOperatorHandsFree(vo.deps, () => {}, true)
    const lines: string[] = []
    const stream = link.openStream((line) => lines.push(line), () => {})
    stream!.write('{"type":"hello","role":"stream"}')
    expect(vo.connections[0].written).toEqual([{ type: 'hello', role: 'stream' }])
    vo.connections[0].say({ type: 'welcome' })
    expect(lines).toEqual(['{"type":"welcome"}'])
    expect(new VoiceOperatorHandsFree(fakeVoiceOperator(null).deps, () => {}, true).openStream(() => {}, () => {})).toBeUndefined()
  })
})

describe('handsFreeAction', () => {
  it('gives Control the words, the wake word off, and stops it on a cut-in', () => {
    expect(handsFreeAction({ type: 'transcript', text: 'Control, run the tests.', trigger: 'control', interrupted: false }))
      .toEqual({ kind: 'words', text: 'run the tests.', interrupted: false })
    expect(handsFreeAction({ type: 'transcript', text: 'Control.', trigger: 'control', interrupted: true }))
      .toEqual({ kind: 'words', text: '', interrupted: true })
    expect(handsFreeAction({ type: 'cut-in', msAgo: 312.4 })).toEqual({ kind: 'cut-in', msAgo: 312 })
    expect(handsFreeAction({ type: 'state', phase: 'listening' })).toBeUndefined()
  })
})

describe('HandsFreePresence', () => {
  it('holds Control from the first syllable until the words are handed over', () => {
    const changes: boolean[] = []
    const p = new HandsFreePresence((s) => changes.push(s))
    p.see('mac', { type: 'state', phase: 'hearing' })
    p.see('mac', { type: 'state', phase: 'sending' })
    expect(changes).toEqual([true])
    p.see('mac', { type: 'transcript', text: 'Control, go.' })
    p.see('mac', { type: 'state', phase: 'listening' })
    expect(changes).toEqual([true, false])
  })

  it('lets go when nothing was caught, and holds while any session is talking', () => {
    const changes: boolean[] = []
    const p = new HandsFreePresence((s) => changes.push(s))
    p.see('mac', { type: 'state', phase: 'hearing' })
    p.see('stream:1', { type: 'state', phase: 'hearing' })
    p.see('mac', { type: 'state', phase: 'listening' })
    expect(changes).toEqual([true])
    p.see('stream:1', { type: 'session-ended', why: 'lost' })
    expect(changes).toEqual([true, false])
  })
})
