import type { HandsFreeTuning } from '../shared/protocol'
import type { SpeechResponse, VoiceOperator } from './voice-operator'

/**
 * The server's half of hands-free mode: the wake-word and speech checks
 * relayed to Voice Operator, and the operator's tuning file. The listening
 * itself happens on the device holding its microphone open
 * (`src/mobile/hands-free.ts`); only the first second of speech that follows
 * a quiet spell gets this far.
 */

/** The word that starts a hands-free dictation: the first word of what is said. */
export const WAKE_WORD = 'control'

/**
 * Sounds Apple's model writes down as words that are not anyone saying
 * anything to Control: filler, and what it hears in a cough or a breath.
 * Speech made only of these does not start a dictation in the conversation
 * window. The operator adds to it with `ignoredWords` in the tuning file.
 */
export const DEFAULT_IGNORED_WORDS: readonly string[] = ['hmm', 'hm', 'mm', 'mmm', 'mhm', 'uh', 'um', 'er', 'ah', 'uh-huh']

/** `wakeWord`: for a `speech` check, whether the words began with the wake word. */
export type WakeWordOutcome = { ok: true; match: boolean; wakeWord?: boolean } | { ok: false; error: string }

type Voice = Pick<VoiceOperator, 'checkWakeWord'>

/** Lowercased words, punctuation dropped (apostrophes and hyphens kept). */
export function spokenWords(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}'\-\s]/gu, ' ').split(/\s+/).filter(Boolean)
}

/** `words` with every ignored word or phrase ("thank you") taken out, wherever it falls. */
export function withoutIgnored(words: readonly string[], ignored: readonly string[]): string[] {
  const phrases = ignored.map(spokenWords).filter((p) => p.length > 0).sort((a, b) => b.length - a.length)
  const out: string[] = []
  for (let i = 0; i < words.length;) {
    const phrase = phrases.find((p) => p.every((w, j) => words[i + j] === w))
    if (phrase) i += phrase.length
    else out.push(words[i++])
  }
  return out
}

/**
 * Ask Voice Operator about `pcm` (16 kHz s16le mono, the start of an utterance):
 * `wake-word` — does it begin with "control"? `speech` — the conversation
 * window — is it words at all, rather than a cough or filler? `log` hears the
 * words of a short `speech` clip (two words or fewer), so that what the model
 * hears in nothing at all can be found and ignored; nothing longer is logged.
 */
export async function checkWakeWord(
  voice: Voice, pcm: Uint8Array, mode: 'wake-word' | 'speech' = 'wake-word',
  ignoredWords: readonly string[] = DEFAULT_IGNORED_WORDS, log: (message: string) => void = () => {},
): Promise<WakeWordOutcome> {
  const response: SpeechResponse = await voice.checkWakeWord(pcm, WAKE_WORD, mode === 'speech' ? 'speech' : 'start')
  if (!response) return { ok: false, error: 'Voice Operator is not running, so the wake word cannot be checked' }
  const body = response.body as { match?: unknown; heard?: unknown; error?: string; detail?: string } | undefined
  if (response.status !== 200 || typeof body?.match !== 'boolean') {
    return { ok: false, error: `Voice Operator could not check the wake word: ${body?.detail ?? body?.error ?? `HTTP ${response.status}`}` }
  }
  if (mode === 'wake-word') return { ok: true, match: body.match }
  const words = spokenWords(typeof body.heard === 'string' ? body.heard : '')
  const real = withoutIgnored(words, ignoredWords)
  if (words.length > 0 && words.length <= 2) log(`speech check heard "${words.join(' ')}"${real.length ? '' : ' — ignored'}`)
  return { ok: true, match: real.length > 0, wakeWord: words[0] === WAKE_WORD }
}

const TUNING_KEYS: ReadonlyArray<keyof HandsFreeTuning> = [
  'noSpeechBeforeMs', 'onsetWindowMs', 'wordMinMs', 'pauseCheckMs', 'turnThreshold', 'wakeWordOnlyMs', 'afterWakeWordMs',
  'endSilenceMinMs', 'endSilenceMaxMs', 'endSilenceRampMs', 'maxUtteranceMs', 'playbackTailMs', 'conversationMs',
  'ignoredWords',
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
    } else if (key === 'ignoredWords') {
      if (Array.isArray(value) && value.every((w) => typeof w === 'string')) tuning.ignoredWords = value as string[]
      else problems.push('"ignoredWords" must be a list of words')
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`"${key}" must be a non-negative number`)
    } else {
      (tuning as Record<string, number>)[key] = value
    }
  }
  return { tuning, problems }
}
