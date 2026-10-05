import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HandsFreeTuning } from '../shared/protocol'
import type { DictationOptions } from './dictation'
import type { Capture } from './held-microphone'
import { cleanHandsFreeText, installHandsFree, useHandsFree, type HandsFreeDeps } from './hands-free'

/** "Speech" is a tone at about −20 dBFS, "quiet" a room's hiss: see wake-listener.test.ts. */
const RATE = 16_000
let seed = 7
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
const quiet = (ms: number) => Float32Array.from({ length: (ms / 1000) * RATE }, () => (noise() * 10) / 32768)
const speech = (ms: number) => Float32Array.from({ length: (ms / 1000) * RATE }, (_, i) => (Math.sin((2 * Math.PI * 200 * i) / RATE) * 4000) / 32768)

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function harness({ isWakeWord = true, transcript = 'Control, what is Kevin doing? Over and out.', turn = null as number | null } = {}) {
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
  let haptics = 0
  const dictations: Array<{ backlogSeconds: number; endPhrase?: string; finished: boolean; cancelled: boolean; turnChecks: number; sayEndPhrase: () => void }> = []
  let quietFor = 10_000
  const deps: HandsFreeDeps = {
    api: {
      handsFree: {
        checkWakeWord: async (pcm) => { checked.push(pcm.length); return { match: isWakeWord } },
        say: (text) => said.push(text),
        onTuning: (cb) => { tuningListener = cb; return () => {} },
      },
      dictation: { start: async () => 'id', audio: () => {}, finish: async () => '', cancel: () => {}, turnCheck: async () => null, onEndPhrase: () => () => {} },
    },
    log: () => {},
    heldCapture: () => held,
    onHoldStateChange: (fn) => { holdChanged = fn; return () => {} },
    quietForMs: () => quietFor,
    playCue: (cue) => { cues.push(cue) },
    haptic: () => { haptics++ },
    beginDictation: async (options: DictationOptions) => {
      const d = {
        backlogSeconds: (options.backlog?.().length ?? 0) / RATE,
        endPhrase: options.endPhrase,
        finished: false,
        cancelled: false,
        turnChecks: 0,
        sayEndPhrase: () => options.onEndPhrase?.(),
      }
      dictations.push(d)
      return {
        finish: async () => { d.finished = true; return transcript },
        cancel: () => { d.cancelled = true },
        checkTurn: async () => { d.turnChecks++; return turn },
      }
    },
    othersDictating: () => false,
    // The stuck-dictation backstop never fires in a test.
    sleep: () => new Promise(() => {}),
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
    haptics: () => haptics,
    setQuietFor: (ms: number) => { quietFor = ms },
    dropHold: () => { held = undefined; holdChanged() },
    tune: (t: Partial<HandsFreeTuning>) => tuningListener(t),
  }
}

let h: ReturnType<typeof harness> | undefined
beforeEach(() => useHandsFree.setState({ phase: 'off' }))
afterEach(() => { h?.uninstall(); h = undefined })

describe('hands-free mode', () => {
  it('"Control, …" said straight through: dictated from its first syllable, ended by quiet', async () => {
    h = harness({ transcript: 'Control, what is Kevin doing?' })
    expect(useHandsFree.getState().phase).toBe('listening')
    await h.hear(quiet(1500), speech(1500))
    expect(h.checked).toHaveLength(1)
    // Felt and seen, not heard: a start tone would land mid-sentence.
    expect(h.haptics()).toBe(1)
    expect(h.cues).toEqual([])
    expect(useHandsFree.getState().phase).toBe('hearing')
    // Wispr gets everything since the user started, not just what came after the check.
    expect(h.dictations[0].backlogSeconds).toBeGreaterThan(1)
    expect(h.dictations[0].endPhrase).toBe('over and out')
    await h.hear(speech(1500), quiet(2000))
    expect(h.said).toEqual(['what is Kevin doing?'])
    expect(h.cues).toEqual(['listeningFinished', 'pasted'])
    expect(useHandsFree.getState().phase).toBe('listening')
  })

  it('ends the moment "over and out" is heard, without waiting for quiet', async () => {
    h = harness()
    await h.hear(quiet(1500), speech(1500))
    h.dictations[0].sayEndPhrase()
    await settle()
    expect(h.said).toEqual(['what is Kevin doing?'])
    expect(h.dictations[0].finished).toBe(true)
  })

  it('ends at the first pause where the turn model is sure the speaker has finished', async () => {
    h = harness({ turn: 0.93 })
    await h.hear(quiet(1500), speech(2500), quiet(500))
    expect(h.dictations[0].turnChecks).toBe(1)
    expect(h.said).toEqual(['what is Kevin doing?'])
  })

  it('waits through a pause the turn model hears as unfinished, until patience runs out', async () => {
    h = harness({ turn: 0.08 })
    await h.hear(quiet(1500), speech(2500), quiet(1000), speech(1500), quiet(1000))
    expect(h.dictations[0].turnChecks).toBe(2)
    expect(h.said).toEqual([])
    expect(useHandsFree.getState().phase).toBe('hearing')
    // Still unsure, but a short request's patience is a second and a half.
    await h.hear(quiet(1000))
    expect(h.said).toEqual(['what is Kevin doing?'])
  })

  it('stays quiet when the Mac says the speech did not start with "control"', async () => {
    h = harness({ isWakeWord: false })
    await h.hear(quiet(1500), speech(1500), quiet(800))
    expect(h.checked).toHaveLength(1)
    expect(h.dictations).toHaveLength(0)
    expect(h.haptics()).toBe(0)
  })

  it('checks only speech that follows a quiet spell, never mid-conversation', async () => {
    h = harness({ isWakeWord: false })
    await h.hear(quiet(1500), speech(3000), quiet(400), speech(2000), quiet(300), speech(1000), quiet(400))
    expect(h.checked).toHaveLength(1)
  })

  it('does not listen while this device is playing, nor just after', async () => {
    h = harness()
    h.setQuietFor(0)
    await h.hear(quiet(1500), speech(1500), quiet(800))
    expect(h.checked).toEqual([])
    // Playback over: it needs a full silenceBefore of its own before speech counts.
    h.setQuietFor(10_000)
    await h.hear(speech(1500), quiet(800))
    expect(h.checked).toEqual([])
    await h.hear(quiet(1000), speech(1500))
    expect(h.checked).toHaveLength(1)
  })

  it('sends nothing when only the wake word was said', async () => {
    h = harness({ transcript: 'Control.' })
    await h.hear(quiet(1500), speech(500), quiet(2500))
    expect(h.dictations[0].finished).toBe(true)
    expect(h.said).toEqual([])
    expect(h.cues).toEqual(['listeningFinished'])
  })

  it('stops listening when the microphone is no longer held', async () => {
    h = harness()
    h.dropHold()
    expect(useHandsFree.getState().phase).toBe('off')
  })
})

describe('cleanHandsFreeText', () => {
  it('takes the wake word off the front and the end phrase off the end', () => {
    expect(cleanHandsFreeText('Control, what is Kevin doing? Over and out.')).toBe('what is Kevin doing?')
    expect(cleanHandsFreeText('control what is Kevin doing over and out')).toBe('what is Kevin doing')
    expect(cleanHandsFreeText('Control. Tell Evan to stop, over & out')).toBe('Tell Evan to stop')
  })

  it('cuts at the last "over and out", dropping whatever came after it', () => {
    expect(cleanHandsFreeText('Control, ask if it is over and outside. Over and out. Thanks')).toBe('ask if it is over and outside.')
  })

  it('leaves "control" alone anywhere but first, and is empty when nothing else was said', () => {
    expect(cleanHandsFreeText('Take control of the build.')).toBe('Take control of the build.')
    expect(cleanHandsFreeText('Control.')).toBe('')
    expect(cleanHandsFreeText('Control, over and out.')).toBe('')
  })
})
