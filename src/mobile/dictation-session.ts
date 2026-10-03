import { create } from 'zustand'
import { Dictation, whenHearing } from './dictation'
import { playCue } from './cues'

/**
 * The phone's one dictation, which outlives the composer that started it.
 *
 * Start talking in one surface's composer, leave it, open another's — the
 * microphone is still on, and whichever composer is open when it stops takes
 * the words, at its caret. Meanwhile a mark at the bottom of the screen says
 * it is listening (MobileApp). The cues are Voice Operator's, as before:
 * started once sound is really arriving, finished, and the failure tones.
 *
 * What was said is the composer's to place, not this store's: it hands the
 * transcript back from `finish` and the composer inserts it.
 */

export type MicState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'listening'; dictation: Dictation }
  | { kind: 'transcribing' }

interface DictationSession {
  mic: MicState
  /** Why the last start or finish failed, until the next attempt. */
  error: string | null
  /**
   * Listen, with a dictation begun inside the tap that asked for it (iOS
   * allows nothing else). Ignored, and the extra dictation dropped, while one
   * is already under way.
   */
  start(pending: Promise<Dictation>): Promise<void>
  /** Stop listening; resolves to what was said, or null when it failed. */
  finish(): Promise<string | null>
}

const message = (err: unknown) => err instanceof Error ? err.message : String(err)

export const useDictationSession = create<DictationSession>((set, get) => ({
  mic: { kind: 'idle' },
  error: null,

  async start(pending) {
    if (get().mic.kind !== 'idle') {
      void pending.then((extra) => extra.cancel(), () => undefined)
      return
    }
    set({ mic: { kind: 'starting' }, error: null })
    try {
      // As on the desktop, the start cue means "safe to talk".
      const dictation = await whenHearing(pending)
      set({ mic: { kind: 'listening', dictation } })
      playCue('listeningStarted')
    } catch (err) {
      set({ mic: { kind: 'idle' }, error: message(err) })
      playCue('captureFailed')
    }
  },

  async finish() {
    const mic = get().mic
    if (mic.kind !== 'listening') return null
    playCue('listeningFinished')
    set({ mic: { kind: 'transcribing' }, error: null })
    try {
      const transcript = await mic.dictation.finish()
      set({ mic: { kind: 'idle' } })
      return transcript
    } catch (err) {
      set({ mic: { kind: 'idle' }, error: message(err) })
      playCue('transcriptionFailed')
      return null
    }
  }
}))
