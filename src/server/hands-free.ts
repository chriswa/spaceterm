import type { HandsFreeTuning } from '../shared/protocol'
import type { SpeechResponse, VoiceOperator } from './voice-operator'

/**
 * The server's half of hands-free mode: the wake-word check relayed to Voice
 * Operator, and the operator's tuning file. The listening itself happens on
 * the device holding its microphone open (`src/mobile/hands-free.ts`); only
 * clips that already look like one word said on its own get this far.
 */

/** The word that starts a hands-free dictation: the first word of what is said. */
export const WAKE_WORD = 'control'
/** The phrase that ends one, wherever it is said; watched for on-device. */
export const END_PHRASE = 'over and out'

export type WakeWordOutcome = { ok: true; match: boolean } | { ok: false; error: string }

type Voice = Pick<VoiceOperator, 'checkWakeWord'>

/** Ask Voice Operator whether `pcm` (16 kHz s16le mono, the start of an utterance) begins with the wake word. */
export async function checkWakeWord(voice: Voice, pcm: Uint8Array): Promise<WakeWordOutcome> {
  const response: SpeechResponse = await voice.checkWakeWord(pcm, WAKE_WORD, 'start')
  if (!response) return { ok: false, error: 'Voice Operator is not running, so the wake word cannot be checked' }
  const body = response.body as { match?: unknown; error?: string; detail?: string } | undefined
  if (response.status === 200 && typeof body?.match === 'boolean') return { ok: true, match: body.match }
  return { ok: false, error: `Voice Operator could not check the wake word: ${body?.detail ?? body?.error ?? `HTTP ${response.status}`}` }
}

const TUNING_KEYS: ReadonlyArray<keyof HandsFreeTuning> = [
  'silenceBeforeMs', 'onsetWindowMs', 'wordMinMs', 'pauseCheckMs', 'turnThreshold',
  'endSilenceMinMs', 'endSilenceMaxMs', 'endSilenceRampMs', 'maxUtteranceMs', 'playbackTailMs',
]

/**
 * `~/.spaceterm/hands-free.json` as overrides: every known key holding a
 * non-negative number, and a note for anything else so a typo is not silently
 * ignored. A missing file is no overrides, not a problem.
 */
export function parseHandsFreeTuning(text: string | undefined): { tuning: Partial<HandsFreeTuning>; problems: string[] } {
  if (text === undefined || text.trim() === '') return { tuning: {}, problems: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { tuning: {}, problems: [`not JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { tuning: {}, problems: ['not a JSON object'] }
  const tuning: Partial<HandsFreeTuning> = {}
  const problems: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (!(TUNING_KEYS as readonly string[]).includes(key)) {
      problems.push(`unknown key "${key}" (known: ${TUNING_KEYS.join(', ')})`)
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`"${key}" must be a non-negative number`)
    } else {
      tuning[key as keyof HandsFreeTuning] = value
    }
  }
  return { tuning, problems }
}
