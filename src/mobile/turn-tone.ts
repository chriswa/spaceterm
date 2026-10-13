/**
 * The turn tone: a tuning aid for hands-free's turn threshold. While a
 * dictation is being taken down and the speaker has fallen quiet, the turn
 * model (Smart Turn, on the Mac) is asked every `TURN_TONE_MS` whether they
 * sound finished, and each answer is played at once as a short tone — low
 * for "still going", high for "finished" — so how its verdict moves through
 * a pause can be heard. A tone at or above the threshold is held a little
 * longer: that is a verdict that would end the dictation at a pause.
 *
 * Quiet is the phone's voice-activity model (Silero VAD) saying nobody is
 * talking, from about 160 ms after the last word — speech, not loudness, so
 * a noisy room does not hold the tones off. Talking again silences them, and
 * an answer that arrives after the speaker has started again is not played.
 *
 * Switched by `TURN_TONE_MS` below: 0 turns it off. The model answers in
 * about 70–130 ms, and one question waits for the last, so the tones come no
 * faster than that.
 * Each dictation's answers are recorded as one `hands-free-turn-tone` line.
 */

/** How often to ask while the speaker is quiet, in ms; 0 turns the turn tone off. */
export const TURN_TONE_MS = 75

/** p = 0 sounds A3, p = 1 three octaves up at A6; whole semitones, so a change is a step you can hear. */
const LOW_HZ = 220
const OCTAVES = 3

export function turnTonePitch(p: number): number {
  const semitones = Math.round(Math.min(1, Math.max(0, p)) * OCTAVES * 12)
  return LOW_HZ * 2 ** (semitones / 12)
}

/** Short enough to sit between answers; longer where the verdict would end the dictation. */
export const TURN_TONE_SECONDS = 0.035
export const TURN_TONE_ENDING_SECONDS = 0.07

/** While the speaker talks, how often to look for them stopping: about a frame. */
const QUIET_POLL_MS = 30

/** The most answers kept for the record: ten minutes at ten a second. */
const MAX_SAMPLES = 6000

export interface TurnToneDeps {
  /** Ask the turn model about the dictation so far; null when it cannot say. */
  check(): Promise<number | null>
  /** The speaker is not talking: only then is anything asked or played. */
  quiet(): boolean
  play(frequency: number, seconds: number): void
  sleep(ms: number): Promise<void>
  now(): number
}

/**
 * While quiet: ask, play the answer, wait out the rest of the interval, and
 * again, until `stop` — which returns every answer played as [ms since the
 * start, p].
 */
export function startTurnTone(intervalMs: number, threshold: number, deps: TurnToneDeps): { stop(): Array<[number, number]> } {
  let running = true
  const samples: Array<[number, number]> = []
  const start = deps.now()
  void (async () => {
    while (running) {
      if (!deps.quiet()) {
        await deps.sleep(QUIET_POLL_MS)
        continue
      }
      const asked = deps.now()
      const p = await deps.check().catch(() => null)
      if (!running) break
      if (p !== null && deps.quiet()) {
        if (samples.length < MAX_SAMPLES) samples.push([Math.round(asked - start), Math.round(p * 1000) / 1000])
        deps.play(turnTonePitch(p), p >= threshold ? TURN_TONE_ENDING_SECONDS : TURN_TONE_SECONDS)
      }
      await deps.sleep(Math.max(0, intervalMs - (deps.now() - asked)))
    }
  })()
  return {
    stop() {
      running = false
      return samples
    },
  }
}
