import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HandsFreeTuning } from '../shared/protocol'
import type { Capture } from './held-microphone'
import { installHandsFree, useHandsFree, type HandsFreeDeps } from './hands-free'

/** "Speech" is a tone at about −20 dBFS, "quiet" a room's hiss: see wake-listener.test.ts. */
const RATE = 16_000
let seed = 7
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
const quiet = (ms: number) => Float32Array.from({ length: (ms / 1000) * RATE }, () => (noise() * 10) / 32768)
const speech = (ms: number) => Float32Array.from({ length: (ms / 1000) * RATE }, (_, i) => (Math.sin((2 * Math.PI * 200 * i) / RATE) * 4000) / 32768)

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function harness({ isWakeWord = true, transcript = 'What is Kevin doing?' } = {}) {
  const listeners = new Set<(block: Float32Array) => void>()
  const capture: Capture = {
    sampleRate: RATE,
    listen: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    healthy: () => true,
    release: () => undefined,
    describe: () => 'fake microphone',
  }
  let held: Capture | undefined = capture
  let holdChanged = () => {}
  let tuningListener: (t: Partial<HandsFreeTuning>) => void = () => {}
  const said: string[] = []
  const checked: number[] = []
  const cues: string[] = []
  const dictations: Array<{ finished: boolean; cancelled: boolean }> = []
  let quietFor = 10_000
  const deps: HandsFreeDeps = {
    api: {
      handsFree: {
        checkWakeWord: async (pcm) => { checked.push(pcm.length); return { match: isWakeWord } },
        say: (text) => said.push(text),
        onTuning: (cb) => { tuningListener = cb; return () => {} },
      },
      dictation: { start: async () => 'id', audio: () => {}, finish: async () => '', cancel: () => {} },
    },
    log: () => {},
    heldCapture: () => held,
    onHoldStateChange: (fn) => { holdChanged = fn; return () => {} },
    quietForMs: () => quietFor,
    playCue: (cue) => { cues.push(cue) },
    cueMs: () => 100,
    beginDictation: async () => {
      const d = { finished: false, cancelled: false }
      dictations.push(d)
      return { finish: async () => { d.finished = true; return transcript }, cancel: () => { d.cancelled = true } }
    },
    othersDictating: () => false,
    // The cue's wait passes at once; the stuck-dictation backstop never does.
    sleep: (ms) => ms < 10_000 ? Promise.resolve() : new Promise(() => {}),
  }
  const uninstall = installHandsFree(deps.api, deps)
  /** Feed audio in microphone-sized blocks, letting promises run between them. */
  const hear = async (...parts: Float32Array[]) => {
    for (const part of parts) {
      for (let i = 0; i < part.length; i += 1600) {
        for (const fn of listeners) fn(part.subarray(i, i + 1600))
        await settle()
      }
    }
  }
  return {
    hear, said, checked, cues, dictations, uninstall,
    setQuietFor: (ms: number) => { quietFor = ms },
    dropHold: () => { held = undefined; holdChanged() },
    tune: (t: Partial<HandsFreeTuning>) => tuningListener(t),
  }
}

let h: ReturnType<typeof harness> | undefined
beforeEach(() => useHandsFree.setState({ phase: 'off' }))
afterEach(() => { h?.uninstall(); h = undefined })

describe('hands-free mode', () => {
  it('"Control", a pause, the cue, then what was said goes to Control', async () => {
    h = harness()
    expect(useHandsFree.getState().phase).toBe('listening')
    await h.hear(quiet(1500), speech(500), quiet(800))
    expect(h.checked).toHaveLength(1)
    expect(h.cues).toEqual(['listeningStarted'])
    expect(useHandsFree.getState().phase).toBe('hearing')
    await h.hear(quiet(300), speech(1500), quiet(2000))
    expect(h.said).toEqual(['What is Kevin doing?'])
    expect(h.cues).toEqual(['listeningStarted', 'listeningFinished', 'pasted'])
    expect(useHandsFree.getState().phase).toBe('listening')
  })

  it('stays quiet when the Mac says it was some other word', async () => {
    h = harness({ isWakeWord: false })
    await h.hear(quiet(1500), speech(500), quiet(800))
    expect(h.checked).toHaveLength(1)
    expect(h.cues).toEqual([])
    expect(h.dictations).toHaveLength(0)
  })

  it('sends nothing to be checked from ordinary conversation', async () => {
    h = harness()
    await h.hear(quiet(1500), speech(3000), quiet(400), speech(2000), quiet(1500))
    expect(h.checked).toEqual([])
  })

  it('does not listen while this device is playing, nor just after', async () => {
    h = harness()
    h.setQuietFor(0)
    await h.hear(quiet(1500), speech(500), quiet(800))
    expect(h.checked).toEqual([])
    // Playback over: it needs a full silenceBefore of its own before a word counts.
    h.setQuietFor(10_000)
    await h.hear(speech(500), quiet(800))
    expect(h.checked).toEqual([])
    await h.hear(quiet(1000), speech(500), quiet(800))
    expect(h.checked).toHaveLength(1)
  })

  it('gives up quietly when nothing is said after the cue', async () => {
    h = harness()
    h.tune({ noSpeechTimeoutMs: 2000 })
    await h.hear(quiet(1500), speech(500), quiet(800))
    await h.hear(quiet(2500))
    expect(h.dictations[0]).toEqual({ finished: false, cancelled: true })
    expect(h.said).toEqual([])
    expect(useHandsFree.getState().phase).toBe('listening')
  })

  it('stops listening when the microphone is no longer held', async () => {
    h = harness()
    h.dropHold()
    expect(useHandsFree.getState().phase).toBe('off')
  })
})
