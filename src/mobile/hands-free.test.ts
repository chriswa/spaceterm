import { afterEach, describe, expect, it } from 'vitest'
import { endSilence, installHandsFree, phoneHandsFreeLink, setHandsFree, useHandsFree, type HandsFreeDeps } from './hands-free'
import type { NativeHandsFreeMessage } from './native-microphone'

/**
 * Voice Operator does the listening; this follows what it says. Each test
 * plays Voice Operator's side as its messages (its DESIGN.md, "Hands-free").
 */
function harness() {
  const listeners = new Set<(event: Record<string, unknown>, audio: boolean) => void>()
  const calls: string[] = []
  const tones: string[] = []
  const cues: string[] = []
  const haptics: string[] = []
  const pending: boolean[] = []
  let cutIns = 0
  let now = 1_000_000
  const tickers = new Set<() => void>()
  const deps: HandsFreeDeps = {
    link: {
      start: () => calls.push('start'),
      stop: () => calls.push('stop'),
      onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    },
    log: () => {},
    handsFreeCue: (cue) => { tones.push(cue) },
    playCue: (cue) => { cues.push(cue) },
    pendingTone: (on) => { pending.push(on) },
    haptic: (pattern) => { haptics.push(pattern) },
    noteCutIn: () => { cutIns++ },
    record: () => {},
    now: () => now,
    every: (_ms, fn) => { tickers.add(fn); return () => tickers.delete(fn) },
  }
  const uninstall = installHandsFree(deps)
  const vo = (event: Record<string, unknown>, audio = true) => { for (const fn of listeners) fn(event, audio) }
  const state = (phase: string, extra: Record<string, unknown> = {}) =>
    vo({ type: 'state', phase, conversation: false, closesAt: null, checking: false, pending: false, ...extra })
  return {
    uninstall, vo, state, calls, tones, cues, haptics, pending, cutIns: () => cutIns,
    elapse: (ms: number) => { now += ms; for (const fn of tickers) fn() },
    now: () => now,
  }
}

let h: ReturnType<typeof harness> | undefined
afterEach(() => { h?.uninstall(); h = undefined })

describe('hands-free, following Voice Operator', () => {
  it('switches Voice Operator on and off', () => {
    h = harness()
    setHandsFree(true)
    setHandsFree(true)
    setHandsFree(false)
    expect(h.calls).toEqual(['start', 'stop'])
  })

  it('shows its phase, window and checking', () => {
    h = harness()
    h.state('listening', { conversation: true, checking: true })
    expect(useHandsFree.getState()).toMatchObject({ phase: 'listening', conversation: true, checking: true, secondsLeft: 15 })
    h.state('hearing')
    expect(useHandsFree.getState().phase).toBe('hearing')
  })

  it('knows when Voice Operator is not listening, and why, until it listens again or ends', () => {
    h = harness()
    h.state('listening', { standingAside: 'speech' })
    expect(useHandsFree.getState().standingAside).toBe('speech')
    h.state('listening', { standingAside: 'dictation' })
    expect(useHandsFree.getState().standingAside).toBe('dictation')
    h.state('listening', { standingAside: 'something-new' })
    expect(useHandsFree.getState().standingAside).toBeNull()
    h.state('listening', { standingAside: 'speech' })
    h.state('listening')
    expect(useHandsFree.getState().standingAside).toBeNull()
    h.state('listening', { standingAside: 'speech' })
    h.vo({ type: 'session-ended', why: 'restarting' })
    expect(useHandsFree.getState().standingAside).toBeNull()
  })

  it('counts the window down from when Voice Operator says it closes', () => {
    h = harness()
    h.state('listening', { conversation: true, closesAt: h.now() + 9_500 })
    expect(useHandsFree.getState().secondsLeft).toBe(10)
    h.elapse(5_000)
    expect(useHandsFree.getState().secondsLeft).toBe(5)
    h.state('listening', { conversation: false })
    expect(useHandsFree.getState().secondsLeft).toBeNull()
  })

  it('beeps while Voice Operator is deciding, and stops before the cue that says what it decided', () => {
    h = harness()
    h.state('listening', { pending: true })
    h.vo({ type: 'cue', name: 'notWakeWord' })
    h.state('listening', { pending: false })
    expect(h.pending).toEqual([true, false])
    expect(h.tones).toEqual(['notWakeWord'])
  })

  it('plays its cues as this device\'s tones, and its haptics', () => {
    h = harness()
    for (const name of ['ready', 'dictationStart', 'dictationEnd', 'conversationClosed', 'shutdown']) h.vo({ type: 'cue', name })
    h.vo({ type: 'cue', name: 'dictationStart', haptic: 'tap' })
    h.vo({ type: 'cue', name: 'error' })
    expect(h.tones).toEqual(['handsFreeReady', 'dictationStart', 'dictationEnd', 'conversationClosed', 'controlShutdown', 'dictationStart'])
    expect(h.haptics).toEqual(['tap'])
    expect(h.cues).toEqual(['error'])
  })

  it('animates the quiet gauge between its data points, and shows the turn model\'s answer', () => {
    h = harness()
    expect(endSilence()).toBeNull()
    h.state('hearing')
    expect(endSilence()).toBe(0)
    h.vo({ type: 'gauge', quietSince: h.now(), patienceMs: 4000, mini: 0.3, miniPeak: 0.4, miniThreshold: 0.5 })
    expect(endSilence(h.now() + 1000)).toBeCloseTo(0.25)
    expect(endSilence(h.now() + 9000)).toBe(1)
    expect(useHandsFree.getState().mini).toEqual({ p: 0.3, peak: 0.4, threshold: 0.5 })
    // Sending keeps what ended it.
    h.state('sending')
    expect(useHandsFree.getState().mini).toEqual({ p: 0.3, peak: 0.4, threshold: 0.5 })
    h.state('listening')
    expect(useHandsFree.getState().mini).toBeNull()
    expect(endSilence()).toBeNull()
  })

  it('leaves Control to the server: its words are not handed on here, and a cut-in only explains its silence', () => {
    h = harness()
    h.vo({ type: 'transcript', text: 'Control, what is Kevin doing?', trigger: 'control', interrupted: false, reason: 'finished', shutdown: false })
    h.vo({ type: 'cut-in', msAgo: 2950, at: 0 })
    expect(h.cutIns()).toBe(1)
    expect(h.calls).toEqual([])
  })

  it('shows everything but plays nothing in a window that is not the one playing its sounds', () => {
    h = harness()
    h.vo({ type: 'session', source: 'mac' }, false)
    h.vo({ type: 'state', phase: 'listening', conversation: true, closesAt: null, checking: false, pending: true }, false)
    h.vo({ type: 'cue', name: 'dictationStart', haptic: 'tap' }, false)
    h.vo({ type: 'session-ended', why: 'incognito' }, false)
    expect(h.pending).toEqual([])
    expect(h.tones).toEqual([])
    expect(h.haptics).toEqual([])
    expect(h.cues).toEqual([])
    expect(useHandsFree.getState().on).toBe(false)
  })

  it('shows hands-free on when it was turned on in another window', () => {
    h = harness()
    h.vo({ type: 'session', source: 'mac' }, false)
    h.state('listening')
    expect(useHandsFree.getState()).toMatchObject({ on: true, phase: 'listening' })
  })

  it('goes off when the session ends, and says so unless it was turned off', () => {
    h = harness()
    setHandsFree(true)
    h.state('listening', { conversation: true })
    h.vo({ type: 'session-ended', why: 'off' })
    expect(useHandsFree.getState()).toMatchObject({ phase: 'off', conversation: false, on: true })
    expect(h.cues).toEqual([])
    h.vo({ type: 'session-ended', why: 'incognito' })
    expect(useHandsFree.getState().on).toBe(false)
    expect(h.cues).toEqual(['error'])
    expect(h.calls).toEqual(['start', 'stop'])
  })

  it('turns off when ended by voice, with no error on top of its own cue', () => {
    h = harness()
    setHandsFree(true)
    h.vo({ type: 'cue', name: 'shutdown' })
    h.vo({ type: 'session-ended', why: 'shutdown' })
    expect(useHandsFree.getState().on).toBe(false)
    expect(h.tones).toEqual(['controlShutdown'])
    expect(h.cues).toEqual([])
  })

  it('stays on, getting ready, while Voice Operator restarts', () => {
    h = harness()
    setHandsFree(true)
    h.state('listening')
    h.vo({ type: 'session-ended', why: 'restarting' })
    expect(useHandsFree.getState()).toMatchObject({ on: true, phase: 'off' })
    expect(h.calls).toEqual(['start'])
    expect(h.cues).toEqual([])
  })

  it('goes off quietly when hands-free was turned on on another device', () => {
    h = harness()
    setHandsFree(true)
    h.vo({ type: 'session-ended', why: 'replaced' })
    expect(useHandsFree.getState().on).toBe(false)
    expect(h.calls).toEqual(['start', 'stop'])
    expect(h.cues).toEqual([])
  })
})

describe('the phone\'s link: the SDK\'s lines carried through the server', () => {
  function phone() {
    const toServer: string[] = []
    const toNative: Array<Record<string, unknown>> = []
    let nativeListener: (message: NativeHandsFreeMessage) => void = () => {}
    let streamListener: (message: { kind: 'line'; line: string } | { kind: 'closed' }) => void = () => {}
    let connect: () => void = () => {}
    const link = phoneHandsFreeLink(
      {
        openStream: () => toServer.push('open'),
        streamLine: (line) => toServer.push(line),
        closeStream: () => toServer.push('close'),
        onStream: (fn) => { streamListener = fn; return () => {} },
      },
      () => 'iPhone',
      (fn) => { connect = fn; return () => {} },
      {
        start: (device) => toNative.push({ start: device }),
        stop: () => toNative.push({ stop: true }),
        transport: (open) => toNative.push({ transport: open }),
        line: (line) => toNative.push({ line }),
        on: (fn) => { nativeListener = fn; return () => {} },
      },
    )
    return { link, toServer, toNative, native: (m: NativeHandsFreeMessage) => nativeListener(m), server: (m: { kind: 'line'; line: string } | { kind: 'closed' }) => streamListener(m), reconnect: () => connect() }
  }

  it('starts the SDK and opens the stream; lines go both ways; events reach the listeners', () => {
    const p = phone()
    const events: unknown[] = []
    p.link.onEvent((e) => events.push(e))
    p.link.start()
    expect(p.toNative).toEqual([{ start: 'iPhone' }, { transport: true }])
    expect(p.toServer).toEqual(['open'])
    p.native({ kind: 'line', line: '{"type":"hello"}' })
    p.server({ kind: 'line', line: '{"type":"welcome"}' })
    p.native({ kind: 'event', event: { type: 'state', phase: 'listening' } })
    expect(p.toServer).toEqual(['open', '{"type":"hello"}'])
    expect(p.toNative.at(-1)).toEqual({ line: '{"type":"welcome"}' })
    expect(events).toEqual([{ type: 'state', phase: 'listening' }])
    p.link.dispose()
  })

  it('opens a fresh stream when the server connection comes back, for the SDK to resume on', () => {
    const p = phone()
    p.link.start()
    p.reconnect()
    expect(p.toNative.slice(1)).toEqual([{ transport: true }, { transport: false }, { transport: true }])
    expect(p.toServer).toEqual(['open', 'open'])
    p.link.stop()
    expect(p.toServer.at(-1)).toBe('close')
    expect(p.toNative.slice(-2)).toEqual([{ stop: true }, { transport: false }])
    p.link.dispose()
  })
})
