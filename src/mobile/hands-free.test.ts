import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HandsFreeTuning } from '../shared/protocol'
import type { DictationOptions } from './dictation'
import type { Capture } from './held-microphone'
import { cleanHandsFreeText, installHandsFree, turnFill, useHandsFree, type HandsFreeDeps } from './hands-free'
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

/**
 * `isWords`: the speech check's answer, or one per check, numbered from 0.
 * `justTurnedOn`: start in the window that turning hands-free on opens;
 * otherwise it has run out, and "Control" is needed.
 */
function harness({ slowChecks = false, justTurnedOn = false, isWakeWord = true, isWords = true as boolean | ((nth: number) => boolean), saidWakeWord = false, oldServer = false, transcript = 'Control, what is Kevin doing?', turn = null as number | null,
  heardShutdown = (() => undefined) as (mode: 'wake-word' | 'speech') => 'whole' | 'start' | undefined } = {}) {
  const listeners = new Set<(block: Float32Array) => void>()
  const capture: Capture = {
    sampleRate: RATE,
    listen: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    healthy: () => true,
    release: () => undefined,
    describe: () => 'fake microphone',
  }
  let held: Capture | undefined = capture
  let wanted = true
  let holdChanged = () => {}
  /** Sleeps under way, resolved by `elapse` — the stuck-dictation backstop among them. */
  let sleeps: Array<{ ms: number; resolve: () => void }> = []
  let tuningListener: (t: Partial<HandsFreeTuning>) => void = () => {}
  const said: string[] = []
  const checked: number[] = []
  const modes: string[] = []
  const cues: string[] = []
  /** Hands-free's own tones, apart from the page's cues. */
  const tones: string[] = []
  const haptics: string[] = []
  const dictations: Array<{ backlogSeconds: number; finished: boolean; cancelled: boolean; turnChecks: number }> = []
  let quietFor = 10_000
  const records: Array<{ kind: string; detail?: Record<string, unknown> }> = []
  /** Control's voice playing through the app, with echo cancellation. */
  let controlSpeaking = false
  /** Control's voice playing on another device — the Mac — as the server says. */
  let speakingElsewhere = false
  const ducks: boolean[] = []
  let interrupts = 0
  /** How long before each cut the user began talking, as hands-free told the server. */
  const cutIns: number[] = []
  /** With `slowChecks`, checks wait here for `answerChecks`: the Mac taking its time. */
  const heldChecks: Array<() => void> = []
  const sayCalls: Array<{ text: string; interrupted?: boolean }> = []
  const deps: HandsFreeDeps = {
    api: {
      handsFree: {
        checkWakeWord: async (pcm, mode = 'wake-word') => {
          checked.push(pcm.length)
          modes.push(mode)
          if (slowChecks) await new Promise<void>((resolve) => { heldChecks.push(resolve) })
          // An old server answers every check as the wake-word question, and does not say so.
          if (oldServer) return { match: isWakeWord }
          const shutdown = heardShutdown(mode)
          return mode === 'speech'
            ? { match: typeof isWords === 'function' ? isWords(modes.filter((m) => m === 'speech').length - 1) : isWords, answered: 'speech' as const, wakeWord: saidWakeWord, shutdown }
            : { match: isWakeWord, answered: 'wake-word' as const, shutdown }
        },
        say: (text, interrupted) => { sayCalls.push({ text, interrupted }); if (text) said.push(text) },
        onTuning: (cb) => { tuningListener = cb; return () => {} },
      },
      dictation: { start: async () => 'id', audio: () => {}, finish: async () => '', cancel: () => {}, turnCheck: async () => null },
    },
    log: () => {},
    heldCapture: () => held,
    holdWanted: () => wanted,
    onHoldStateChange: (fn) => { holdChanged = fn; return () => {} },
    quietForMs: () => quietFor,
    playCue: (cue) => { cues.push(cue) },
    handsFreeCue: (cue) => { tones.push(cue) },
    haptic: (pattern) => { haptics.push(pattern) },
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
    sleep: (ms) => new Promise((resolve) => { sleeps.push({ ms, resolve }) }),
    loadScorer: async () => fakeDetector,
    record: (kind, detail) => { records.push({ kind, detail }) },
    nativeSpeech: () => ({ playing: controlSpeaking, outputDb: -18, voiceProcessing: true }),
    controlSpeaking: () => controlSpeaking || speakingElsewhere,
    duckSpeech: (on) => { ducks.push(on) },
    interruptControl: (cutInMsAgo) => { interrupts++; cutIns.push(cutInMsAgo); controlSpeaking = false; speakingElsewhere = false },
  }
  const uninstall = installHandsFree(deps.api, deps)
  const feed = (part: Float32Array) => { for (let i = 0; i < part.length; i += 1600) for (const fn of listeners) fn(part.subarray(i, i + 1600)) }
  const ready = settle().then(async () => {
    if (justTurnedOn) return
    // Let the window turning it on opened run out, in a silent room whatever the test has set, and forget its closing tone and taps.
    const [speaking, quietBefore] = [controlSpeaking, quietFor]
    controlSpeaking = false
    quietFor = 10_000
    for (let i = 0; i < 16; i++) { feed(quiet(1000)); await settle() }
    controlSpeaking = speaking
    quietFor = quietBefore
    tones.length = 0
    haptics.length = 0
  })
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
    hear, said, checked, modes, cues, tones, dictations, records, uninstall, ducks, sayCalls,
    setTranscript: (text: string) => { transcript = text },
    interrupts: () => interrupts,
    cutIns,
    answerChecks: async () => { for (const answer of heldChecks.splice(0)) answer(); await settle() },
    setControlSpeaking: (on: boolean) => { controlSpeaking = on },
    setSpeakingElsewhere: (on: boolean) => { speakingElsewhere = on },
    haptics: () => haptics.length,
    hapticPatterns: haptics,
    setQuietFor: (ms: number) => { quietFor = ms },
    dropHold: () => { wanted = false; held = undefined; holdChanged() },
    /** The app's microphone stalls, still turned on, and is reopened by `reopenHold`. */
    stallHold: () => { held = undefined; holdChanged() },
    reopenHold: () => { held = capture; holdChanged() },
    /** Resolve every sleep of at most `ms`. */
    elapse: async (ms: number) => {
      const due = sleeps.filter((s) => s.ms <= ms)
      sleeps = sleeps.filter((s) => s.ms > ms)
      for (const s of due) s.resolve()
      await settle()
    },
    tune: (t: Partial<HandsFreeTuning>) => tuningListener(t),
  }
}

let h: ReturnType<typeof harness> | undefined
beforeEach(() => useHandsFree.setState({ phase: 'off', conversation: false, secondsLeft: null, turn: null }))
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
    // One tap and two notes up as it was heard, two taps and two notes down as it was sent.
    expect(h.hapticPatterns).toEqual(['tap', 'double'])
    expect(h.tones).toEqual(['dictationStart', 'dictationEnd'])
    expect(h.cues).toEqual([])
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

  it('shows the latest pause\'s answer, with its threshold, while still hearing', async () => {
    h = harness({ turn: 0.08 })
    expect(useHandsFree.getState().turn).toBeNull()
    await h.hear(quiet(1500), speech(2500), quiet(1000))
    expect(useHandsFree.getState().phase).toBe('hearing')
    expect(useHandsFree.getState().turn).toEqual({ p: 0.08, threshold: expect.any(Number) })
  })

  it('forgets the answer the moment they carry on, since it was about a pause that is over', async () => {
    h = harness({ turn: 0.08 })
    await h.hear(quiet(1500), speech(2500), quiet(1000))
    expect(useHandsFree.getState().turn).not.toBeNull()
    await h.hear(speech(500))
    expect(useHandsFree.getState().phase).toBe('hearing')
    expect(useHandsFree.getState().turn).toBeNull()
    // The next pause is asked about afresh, and shown.
    await h.hear(quiet(1000))
    expect(h.dictations[0].turnChecks).toBe(2)
    expect(useHandsFree.getState().turn).toEqual({ p: 0.08, threshold: expect.any(Number) })
  })

  it('forgets the answer once the dictation it was about has ended', async () => {
    h = harness({ turn: 0.93 })
    await h.hear(quiet(1500), speech(2500), quiet(1000))
    expect(h.said).toEqual(['what is Kevin doing?'])
    expect(useHandsFree.getState().turn).toBeNull()
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
    expect(h.hapticPatterns).toEqual(['tap', 'double'])
    expect(h.cues).toEqual([])
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

  it('listens through Control\'s voice when the app plays it: "Control" cuts it off and is dictated', async () => {
    h = harness()
    h.setControlSpeaking(true)
    await h.hear(quiet(1500), speech(1500))
    // Turned down the moment someone spoke, cut off once it was "Control".
    expect(h.ducks[0]).toBe(true)
    expect(h.interrupts()).toBe(1)
    expect(h.dictations).toHaveLength(1)
    await h.hear(speech(1000), quiet(3500))
    expect(h.sayCalls).toEqual([{ text: 'what is Kevin doing?', interrupted: true }])
  })

  it('dates the cut to when they began talking, not to when the Mac said it was "Control"', async () => {
    h = harness({ slowChecks: true })
    h.setControlSpeaking(true)
    await h.hear(quiet(1500), speech(1000))
    // The check takes two more seconds of them talking over Control, turned down and unheard.
    await h.hear(speech(2000))
    expect(h.interrupts()).toBe(0)
    await h.answerChecks()
    expect(h.interrupts()).toBe(1)
    // Three seconds of speech by then, to within a block or two.
    expect(h.cutIns[0]).toBeGreaterThanOrEqual(2900)
    expect(h.cutIns[0]).toBeLessThanOrEqual(3200)
  })

  it('cuts Control off on the Mac too, dated to when they began — not left to the dictation\'s start', async () => {
    h = harness({ slowChecks: true })
    h.setSpeakingElsewhere(true)
    await h.hear(quiet(1500), speech(1000), speech(1000))
    await h.answerChecks()
    expect(h.interrupts()).toBe(1)
    expect(h.cutIns[0]).toBeGreaterThanOrEqual(1900)
    expect(h.records.find((r) => r.kind === 'hands-free-interrupt')?.detail).toMatchObject({ here: false })
    // Nothing was playing here, so there was nothing to turn down.
    expect(h.ducks).toEqual([])
    await h.hear(speech(1000), quiet(3500))
    expect(h.sayCalls).toEqual([{ text: 'what is Kevin doing?', interrupted: true }])
  })

  it('turns Control down for anyone speaking, and back up once it was not "Control" and they stopped', async () => {
    h = harness({ isWakeWord: false })
    h.setControlSpeaking(true)
    await h.hear(quiet(1500), speech(1500), quiet(1000))
    expect(h.ducks).toEqual([true, false])
    expect(h.interrupts()).toBe(0)
  })

  it('cut off, then nothing caught: Control is told, and carries on', async () => {
    h = harness({ transcript: 'Control.' })
    h.setControlSpeaking(true)
    await h.hear(quiet(1500), speech(600), quiet(6000))
    expect(h.interrupts()).toBe(1)
    expect(h.sayCalls).toEqual([{ text: '', interrupted: true }])
    expect(h.records.some((r) => r.kind === 'hands-free-empty-interruption')).toBe(true)
  })

  it('records, per reply, how much of Control\'s voice got past echo cancellation', async () => {
    h = harness()
    h.setControlSpeaking(true)
    await h.hear(quiet(3000))
    h.setControlSpeaking(false)
    await h.hear(quiet(100))
    const echo = h.records.find((r) => r.kind === 'hands-free-echo')?.detail
    expect(echo).toMatchObject({ speechPercent: 0, longestSpeechMs: 0, outputDb: -18, voiceProcessing: true, ducks: 0 })
    expect(echo?.seconds).toBeGreaterThan(2.5)
  })

  describe('the conversation window', () => {
    it('opens as hands-free is turned on: the first words need no "Control"', async () => {
      h = harness({ justTurnedOn: true, transcript: 'What is Kevin doing?' })
      expect(useHandsFree.getState().conversation).toBe(true)
      expect(useHandsFree.getState().secondsLeft).toBe(15)
      await h.hear(quiet(1000), speech(1500), quiet(3500))
      expect(h.modes).toEqual(['speech'])
      expect(h.said).toEqual(['What is Kevin doing?'])
    })

    it('turned on and left quiet, closes after conversationMs, as after "Control"', async () => {
      h = harness({ justTurnedOn: true })
      await h.hear(quiet(15_500))
      expect(useHandsFree.getState().conversation).toBe(false)
      expect(h.tones).toEqual(['conversationClosed'])
    })

    it('is not opened again by the microphone reopening after it ran out', async () => {
      h = harness()
      await h.hear()
      h.stallHold()
      h.reopenHold()
      expect(useHandsFree.getState().conversation).toBe(false)
    })

    /** "Control, …" sent: the window is open. */
    async function inConversation(h: ReturnType<typeof harness>) {
      await h.hear(quiet(1500), speech(1500), quiet(3500))
      expect(h.said).toHaveLength(1)
      expect(useHandsFree.getState().conversation).toBe(true)
    }

    it('after "Control", any words start a dictation — checked only for being words — and nothing is cropped', async () => {
      h = harness()
      await inConversation(h)
      h.setTranscript('Yes, and tell Evan too.')
      await h.hear(quiet(1000), speech(1500), quiet(3500))
      expect(h.modes).toEqual(['wake-word', 'speech'])
      expect(h.said).toEqual(['what is Kevin doing?', 'Yes, and tell Evan too.'])
    })

    it('ignores a cough or filler in the window, as not words', async () => {
      h = harness({ isWords: false })
      await inConversation(h)
      await h.hear(quiet(1000), speech(400), quiet(2000))
      expect(h.modes).toEqual(['wake-word', 'speech'])
      expect(h.dictations).toHaveLength(1)
    })

    it('a short "yes" is the whole answer: no waiting, as after "Control." alone', async () => {
      h = harness({ turn: 0.93 })
      await inConversation(h)
      h.setTranscript('Yes.')
      await h.hear(quiet(1000), speech(500), quiet(1000))
      expect(h.dictations[1].turnChecks).toBe(1)
      expect(h.said).toEqual(['what is Kevin doing?', 'Yes.'])
    })

    it('closes with a tone once both sides have been quiet for conversationMs, and then needs "Control" again', async () => {
      h = harness()
      await inConversation(h)
      await h.hear(quiet(10_000))
      expect(useHandsFree.getState().conversation).toBe(true)
      await h.hear(quiet(5500))
      expect(useHandsFree.getState().conversation).toBe(false)
      expect(h.tones.at(-1)).toBe('conversationClosed')
      expect(h.hapticPatterns.at(-1)).toBe('triple')
      await h.hear(quiet(1000), speech(1500), quiet(500))
      expect(h.modes.at(-1)).toBe('wake-word')
    })

    it('holds open while the user talks for longer than the window, words or not', async () => {
      h = harness({ isWords: false })
      await inConversation(h)
      await h.hear(speech(20_000), quiet(10_000))
      expect(useHandsFree.getState().conversation).toBe(true)
    })

    it('holds open while Control speaks for longer than the window, and counts from when it stops', async () => {
      h = harness()
      await inConversation(h)
      h.setControlSpeaking(true)
      await h.hear(quiet(20_000))
      expect(useHandsFree.getState().conversation).toBe(true)
      h.setControlSpeaking(false)
      await h.hear(quiet(10_000))
      expect(useHandsFree.getState().conversation).toBe(true)
      await h.hear(quiet(5500))
      expect(useHandsFree.getState().conversation).toBe(false)
    })

    it('counts down the seconds of quiet left, full again whenever anyone speaks', async () => {
      h = harness({ isWords: false })
      await inConversation(h)
      await h.hear(quiet(5000))
      expect(useHandsFree.getState().secondsLeft).toBeGreaterThanOrEqual(9)
      expect(useHandsFree.getState().secondsLeft).toBeLessThanOrEqual(10)
      await h.hear(speech(300))
      expect(useHandsFree.getState().secondsLeft).toBe(15)
      await h.hear(quiet(15_500))
      expect(useHandsFree.getState().secondsLeft).toBeNull()
    })

    it('"Control." alone in the window waits for the rest, as outside it', async () => {
      h = harness({ turn: 0.93, saidWakeWord: true })
      await inConversation(h)
      h.setTranscript('Control. What is Evan doing?')
      await h.hear(quiet(1000), speech(600), quiet(3000))
      expect(h.dictations[1].turnChecks).toBe(0)
      expect(useHandsFree.getState().phase).toBe('hearing')
    })

    it('closes, with the tone, and stays closed, when the server is too old to know the window', async () => {
      // An old server answers "does it start with Control?" to everything — fine for opening the window.
      h = harness({ oldServer: true })
      await inConversation(h)
      await h.hear(quiet(1000), speech(1500), quiet(3500))
      expect(h.records.some((r) => r.kind === 'hands-free-server-too-old')).toBe(true)
      expect(h.tones).toContain('conversationClosed')
      // "Control" still works, as before the window; it just does not open one any more.
      expect(h.dictations).toHaveLength(2)
      expect(useHandsFree.getState().conversation).toBe(false)
    })

    it('checks words that follow straight on from a rejected start, and lets them cut Control off', async () => {
      // As heard on AirPods: a faint start Apple's model makes nothing of, then the words straight after.
      h = harness({ isWords: (nth) => nth > 0 })
      await inConversation(h)
      h.setControlSpeaking(true)
      h.setTranscript('No, wait.')
      await h.hear(quiet(1000), speech(350), quiet(400), speech(2000), quiet(3500))
      expect(h.modes).toEqual(['wake-word', 'speech', 'speech'])
      expect(h.interrupts()).toBe(1)
      expect(h.sayCalls.at(-1)).toEqual({ text: 'No, wait.', interrupted: true })
    })

    it('stays open while the app reopens a stalled microphone, so words still cut Control off', async () => {
      h = harness()
      await inConversation(h)
      h.stallHold()
      expect(useHandsFree.getState().conversation).toBe(true)
      h.reopenHold()
      h.setControlSpeaking(true)
      h.setTranscript('No, stop.')
      await h.hear(quiet(1000), speech(1500), quiet(3500))
      expect(h.modes.at(-1)).toBe('speech')
      expect(h.interrupts()).toBe(1)
    })

    it('closes, quietly, when a stalled microphone is not back within conversationMs, or holding is turned off', async () => {
      h = harness()
      await inConversation(h)
      h.stallHold()
      await h.elapse(15_000)
      expect(useHandsFree.getState().conversation).toBe(false)
      expect(h.tones).not.toContain('conversationClosed')

      h.uninstall()
      h = harness()
      await inConversation(h)
      h.dropHold()
      expect(useHandsFree.getState().conversation).toBe(false)
    })

    it('a stall from before the microphone came back does not close the window later', async () => {
      h = harness()
      await inConversation(h)
      h.stallHold()
      h.reopenHold()
      await h.elapse(15_000)
      expect(useHandsFree.getState().conversation).toBe(true)
    })

    it('lets words cut Control off without "Control", when it speaks through echo cancellation', async () => {
      h = harness()
      await inConversation(h)
      h.setControlSpeaking(true)
      h.setTranscript('No, stop.')
      await h.hear(quiet(1000), speech(1500), quiet(3500))
      expect(h.interrupts()).toBe(1)
      expect(h.sayCalls.at(-1)).toEqual({ text: 'No, stop.', interrupted: true })
    })
  })

  describe('"Control, shutdown"', () => {
    it('is sent like any words, and closes the window at once, with its own tone', async () => {
      h = harness({ transcript: 'Control, shut down.' })
      await h.hear(quiet(1500), speech(1500), quiet(3500))
      expect(h.sayCalls).toEqual([{ text: 'shut down.', interrupted: false }])
      expect(useHandsFree.getState().conversation).toBe(false)
      expect(h.tones).toEqual(['dictationStart', 'dictationEnd', 'controlShutdown'])
      expect(h.records.some((r) => r.kind === 'hands-free-shutdown')).toBe(true)
      // Words after it need "Control" again.
      h.setTranscript('Sure, I can look at that.')
      await h.hear(quiet(1000), speech(1500), quiet(3500))
      expect(h.modes.at(-1)).toBe('wake-word')
    })

    it('works alone in the conversation window, cutting Control off', async () => {
      h = harness()
      await h.hear(quiet(1500), speech(1500), quiet(3500))
      expect(useHandsFree.getState().conversation).toBe(true)
      h.setControlSpeaking(true)
      h.setTranscript('Shutdown.')
      await h.hear(quiet(1000), speech(800), quiet(3500))
      expect(h.interrupts()).toBe(1)
      expect(h.sayCalls.at(-1)).toEqual({ text: 'Shutdown.', interrupted: true })
      expect(useHandsFree.getState().conversation).toBe(false)
      expect(h.tones.at(-1)).toBe('controlShutdown')
    })

    it('"let me turn this off" in the window does the same', async () => {
      h = harness()
      await h.hear(quiet(1500), speech(1500), quiet(3500))
      h.setTranscript('Let me turn this off.')
      await h.hear(quiet(1000), speech(1200), quiet(3500))
      expect(h.sayCalls.at(-1)).toEqual({ text: 'Let me turn this off.', interrupted: false })
      expect(useHandsFree.getState().conversation).toBe(false)
      expect(h.tones.at(-1)).toBe('controlShutdown')
    })

    it('does not count inside a longer request', async () => {
      h = harness({ transcript: 'Control, shut down the dev server.' })
      await h.hear(quiet(1500), speech(2500), quiet(3500))
      expect(h.said).toEqual(['shut down the dev server.'])
      expect(useHandsFree.getState().conversation).toBe(true)
      expect(h.tones).not.toContain('controlShutdown')
    })
  })

  describe('"let me turn this off", without "Control"', () => {
    /** Its start heard as the start of the phrase; the whole of it, checked later, as `whole`. */
    const startThen = (whole: 'whole' | undefined) => (mode: 'wake-word' | 'speech') => mode === 'wake-word' ? 'start' as const : whole

    it('waits for the speech to end, checks the whole of it, and sends Control away with the tone', async () => {
      h = harness({ isWakeWord: false, heardShutdown: startThen('whole') })
      await h.hear(quiet(1500), speech(1500), quiet(1000))
      expect(h.modes).toEqual(['wake-word', 'speech'])
      // The whole utterance went to be checked, not just its first second.
      expect(h.checked[1]).toBeGreaterThan(h.checked[0])
      expect(h.dictations).toHaveLength(0)
      expect(h.sayCalls).toEqual([{ text: 'let me turn this off', interrupted: false }])
      expect(h.tones).toEqual(['controlShutdown'])
      expect(useHandsFree.getState().conversation).toBe(false)
      expect(h.records.some((r) => r.kind === 'hands-free-shutdown' && r.detail?.how === 'heard')).toBe(true)
    })

    it('over Control\'s voice, leaves cutting it off to the server letting go', async () => {
      h = harness({ isWakeWord: false, heardShutdown: startThen('whole') })
      h.setControlSpeaking(true)
      await h.hear(quiet(1500), speech(1500), quiet(1000))
      expect(h.interrupts()).toBe(0)
      expect(h.sayCalls).toEqual([{ text: 'let me turn this off', interrupted: false }])
    })

    it('does nothing when the whole of it was something else', async () => {
      h = harness({ isWakeWord: false, heardShutdown: startThen(undefined) })
      await h.hear(quiet(1500), speech(1500), quiet(1000))
      expect(h.modes).toEqual(['wake-word', 'speech'])
      expect(h.sayCalls).toEqual([])
      expect(h.tones).toEqual([])
    })

    it('lets go of speech that runs on, unchecked', async () => {
      h = harness({ isWakeWord: false, heardShutdown: startThen('whole') })
      await h.hear(quiet(1500), speech(6000), quiet(1000))
      expect(h.modes).toEqual(['wake-word'])
      expect(h.sayCalls).toEqual([])
    })

    it('is not watched for at all when its start is not heard as the phrase', async () => {
      h = harness({ isWakeWord: false })
      await h.hear(quiet(1500), speech(1500), quiet(1000))
      expect(h.modes).toEqual(['wake-word'])
    })
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

describe('the turn gauge', () => {
  it('rises with the answer, the threshold at the top', () => {
    expect(turnFill(0, 0.6)).toBe(0)
    expect(turnFill(0.15, 0.6)).toBeCloseTo(0.25)
    expect(turnFill(0.3, 0.6)).toBeLessThan(turnFill(0.45, 0.6))
  })

  it('is whole at the threshold, just short of it, or past it', () => {
    expect(turnFill(0.6, 0.6)).toBe(1)
    expect(turnFill(0.58, 0.6)).toBe(1)
    expect(turnFill(0.9, 0.6)).toBe(1)
  })
})
