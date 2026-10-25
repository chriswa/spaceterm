import { afterEach, describe, expect, it } from 'vitest'
import { cleanHandsFreeText, endSilence, installHandsFree, phoneHandsFreeLink, setHandsFree, useHandsFree, type HandsFreeDeps } from './hands-free'
import type { NativeHandsFreeMessage } from './native-microphone'

/**
 * Voice Operator does the listening; this follows what it says. Each test
 * plays Voice Operator's side as its messages (its DESIGN.md, "Hands-free").
 */
function harness() {
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const calls: string[] = []
  const said: Array<{ text: string; interrupted?: boolean }> = []
  const tones: string[] = []
  const cues: string[] = []
  const haptics: string[] = []
  const pending: boolean[] = []
  const cutIns: number[] = []
  let now = 1_000_000
  const tickers = new Set<() => void>()
  const deps: HandsFreeDeps = {
    api: { handsFree: { say: (text, interrupted) => { said.push({ text, interrupted }) } } },
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
    interruptControl: (ms) => { cutIns.push(ms) },
    record: () => {},
    now: () => now,
    every: (_ms, fn) => { tickers.add(fn); return () => tickers.delete(fn) },
  }
  const uninstall = installHandsFree(deps)
  const vo = (event: Record<string, unknown>) => { for (const fn of listeners) fn(event) }
  const state = (phase: string, extra: Record<string, unknown> = {}) =>
    vo({ type: 'state', phase, conversation: false, closesAt: null, checking: false, pending: false, ...extra })
  return {
    uninstall, vo, state, calls, said, tones, cues, haptics, pending, cutIns,
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
    h.vo({ type: 'gauge', quietSince: h.now(), patienceMs: 4000, turn: 0.3, threshold: 0.85, sampling: true })
    expect(endSilence(h.now() + 1000)).toBeCloseTo(0.25)
    expect(endSilence(h.now() + 9000)).toBe(1)
    expect(useHandsFree.getState().turn).toEqual({ p: 0.3, threshold: 0.85 })
    expect(useHandsFree.getState().sampling).toBe(0.85)
    // Sending keeps what ended it.
    h.state('sending')
    expect(useHandsFree.getState().turn).toEqual({ p: 0.3, threshold: 0.85 })
    h.state('listening')
    expect(useHandsFree.getState().turn).toBeNull()
    expect(endSilence()).toBeNull()
  })

  it('hands Control the words, the wake word taken off', () => {
    h = harness()
    h.vo({ type: 'transcript', text: 'Control, what is Kevin doing?', trigger: 'control', interrupted: false, reason: 'finished', shutdown: false })
    h.vo({ type: 'transcript', text: 'Yes, and tell Evan.', trigger: null, interrupted: true, reason: 'silence', shutdown: false })
    h.vo({ type: 'transcript', text: '', trigger: 'control', interrupted: true, reason: 'lost', shutdown: false })
    expect(h.said).toEqual([
      { text: 'what is Kevin doing?', interrupted: false },
      { text: 'Yes, and tell Evan.', interrupted: true },
      { text: '', interrupted: true },
    ])
  })

  it('passes "Control, shutdown" on as words, which the server sends Control away on', () => {
    h = harness()
    h.vo({ type: 'transcript', text: 'Control, shut down.', trigger: 'control', interrupted: false, reason: 'finished', shutdown: true })
    expect(h.said).toEqual([{ text: 'shut down.', interrupted: false }])
  })

  it('stops Control as of when the user began, when Voice Operator says they cut it off', () => {
    h = harness()
    h.vo({ type: 'cut-in', msAgo: 2950, at: 0 })
    expect(h.cutIns).toEqual([2950])
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
  })
})

describe('cleanHandsFreeText', () => {
  it('takes the wake word off the front', () => {
    expect(cleanHandsFreeText('Control, what is Kevin doing?')).toBe('what is Kevin doing?')
    expect(cleanHandsFreeText('control what is Kevin doing')).toBe('what is Kevin doing')
    expect(cleanHandsFreeText('Control. Tell Evan to stop.')).toBe('Tell Evan to stop.')
    expect(cleanHandsFreeText('Computer, lights.', 'computer')).toBe('lights.')
  })

  it('leaves "control" alone anywhere but first, and is empty when nothing else was said', () => {
    expect(cleanHandsFreeText('Take control of the build.')).toBe('Take control of the build.')
    expect(cleanHandsFreeText('Control.')).toBe('')
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
