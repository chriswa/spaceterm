import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HandsFreeTuning } from '../shared/protocol'
import type { DictationOptions } from './dictation'
import type { Capture } from './held-microphone'
import { cleanHandsFreeText, installHandsFree, useHandsFree, type HandsFreeDeps } from './hands-free'
import type { FrameScorer } from './speech-detector'

/**
 * "Speech" is a 200 Hz tone at about −20 dBFS, "quiet" a room's hiss, and
 * "roar" loud white noise — a busy room, a fan. The fake speech detector
 * below tells them apart as the real one does: loud and tonal is speech,
 * loud and hissing is not.
 */
const RATE = 16_000
let seed = 7
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
const quiet = (ms: number) => Float32Array.from({ length: (ms / 1000) * RATE }, () => (noise() * 10) / 32768)
const roar = (ms: number) => Float32Array.from({ length: (ms / 1000) * RATE }, () => (noise() * 8000) / 32768)
const speech = (ms: number) => Float32Array.from({ length: (ms / 1000) * RATE }, (_, i) => (Math.sin((2 * Math.PI * 200 * i) / RATE) * 4000) / 32768)

/** Speech is loud with few zero crossings; hiss and roar cross zero constantly. */
const fakeDetector: FrameScorer = {
  name: 'fake',
  score(frame) {
    let crossings = 0
    let energy = 0
    for (let i = 0; i < frame.length; i++) {
      energy += frame[i] * frame[i]
      if (i > 0 && (frame[i] >= 0) !== (frame[i - 1] >= 0)) crossings++
    }
    const loud = Math.sqrt(energy / frame.length) > 500
    return loud && crossings / frame.length < 0.15 ? 0.95 : 0.03
  },
  reset() {},
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function harness({ isWakeWord = true, transcript = 'Control, what is Kevin doing?', turn = null as number | null } = {}) {
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
  const dictations: Array<{ backlogSeconds: number; finished: boolean; cancelled: boolean; turnChecks: number }> = []
  let quietFor = 10_000
  const records: Array<{ kind: string; detail?: Record<string, unknown> }> = []
  const deps: HandsFreeDeps = {
    api: {
      handsFree: {
        checkWakeWord: async (pcm) => { checked.push(pcm.length); return { match: isWakeWord } },
        say: (text) => said.push(text),
        onTuning: (cb) => { tuningListener = cb; return () => {} },
      },
      dictation: { start: async () => 'id', audio: () => {}, finish: async () => '', cancel: () => {}, turnCheck: async () => null },
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
        finished: false,
        cancelled: false,
        turnChecks: 0,
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
    loadScorer: async () => fakeDetector,
    record: (kind, detail) => { records.push({ kind, detail }) },
  }
  const uninstall = installHandsFree(deps.api, deps)
  const ready = settle()
  /** Feed audio in microphone-sized blocks, letting promises run between them. */
  const hear = async (...parts: Float32Array[]) => {
    await ready
    for (const part of parts) {
      for (let i = 0; i < part.length; i += 1600) {
        for (const fn of listeners) fn(part.subarray(i, i + 1600))
        await settle()
      }
    }
  }
  return {
    hear, said, checked, cues, dictations, records, uninstall,
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
    await h.hear(speech(1500), quiet(3500))
    expect(h.said).toEqual(['what is Kevin doing?'])
    expect(h.cues).toEqual(['listeningFinished', 'pasted'])
    expect(useHandsFree.getState().phase).toBe('listening')
  })

  it('ends at the first pause where the turn model is sure the speaker has finished', async () => {
    h = harness({ turn: 0.93 })
    await h.hear(quiet(1500), speech(2500), quiet(1000))
    expect(h.dictations[0].turnChecks).toBe(1)
    expect(h.said).toEqual(['what is Kevin doing?'])
  })

  it('waits through a pause the turn model hears as unfinished, until patience runs out', async () => {
    h = harness({ turn: 0.08 })
    await h.hear(quiet(1500), speech(2500), quiet(1000), speech(1500), quiet(1000))
    expect(h.dictations[0].turnChecks).toBe(2)
    expect(h.said).toEqual([])
    expect(useHandsFree.getState().phase).toBe('hearing')
    // Still unsure, but a short request's patience is three seconds.
    await h.hear(quiet(2500))
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

  it('sends nothing when only the wake word was said, once it has waited afterWakeWordMs for more', async () => {
    h = harness({ transcript: 'Control.' })
    await h.hear(quiet(1500), speech(500), quiet(2500))
    expect(h.dictations[0].finished).toBe(false)
    await h.hear(quiet(3000))
    expect(h.dictations[0].finished).toBe(true)
    expect(h.said).toEqual([])
    expect(h.cues).toEqual(['listeningFinished'])
  })

  it('hears "Control" in a loud room: noise is not speech, so it does not count as talk before it', async () => {
    h = harness()
    await h.hear(roar(1500), speech(600), roar(800))
    expect(h.checked).toHaveLength(1)
    expect(h.dictations).toHaveLength(1)
  })

  it('after "Control." alone, does not ask the turn model about the pause, and waits for the rest', async () => {
    h = harness({ turn: 0.93, transcript: 'Control. What is Kevin doing?' })
    await h.hear(quiet(1500), speech(600), quiet(3000))
    expect(h.dictations).toHaveLength(1)
    expect(h.dictations[0].turnChecks).toBe(0)
    expect(useHandsFree.getState().phase).toBe('hearing')
    // Then the request itself, and a pause the turn model hears as finished.
    await h.hear(speech(1500), quiet(1000))
    expect(h.dictations[0].turnChecks).toBe(1)
    expect(h.said).toEqual(['What is Kevin doing?'])
  })

  it('records what it heard and decided — timings, levels and verdicts, never words', async () => {
    h = harness({ isWakeWord: false })
    await h.hear(quiet(1500), speech(1500), quiet(300), speech(800), quiet(800))
    const sightings = h.records.filter((r) => r.kind === 'hands-free-speech').map((r) => r.detail?.verdict)
    expect(sightings).toEqual(['checked', 'after-speech'])
    expect(h.records.find((r) => r.kind === 'wake-word')?.detail).toMatchObject({ match: false })
    expect(h.records.find((r) => r.kind === 'hands-free-detector')?.detail).toEqual({ name: 'fake' })
  })

  it('stops listening when the microphone is no longer held', async () => {
    h = harness()
    h.dropHold()
    expect(useHandsFree.getState().phase).toBe('off')
  })
})

describe('cleanHandsFreeText', () => {
  it('takes the wake word off the front', () => {
    expect(cleanHandsFreeText('Control, what is Kevin doing?')).toBe('what is Kevin doing?')
    expect(cleanHandsFreeText('control what is Kevin doing')).toBe('what is Kevin doing')
    expect(cleanHandsFreeText('Control. Tell Evan to stop.')).toBe('Tell Evan to stop.')
  })

  it('leaves "control" alone anywhere but first, and is empty when nothing else was said', () => {
    expect(cleanHandsFreeText('Take control of the build.')).toBe('Take control of the build.')
    expect(cleanHandsFreeText('Control.')).toBe('')
  })
})
