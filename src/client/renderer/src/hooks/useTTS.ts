import type { SpeakOutcome } from '../../../../shared/protocol'

/**
 * The speak-the-selection gesture.
 *
 * Deliberately thin: the server owns whether anything is being said, so there
 * is no `isSpeaking` here to go stale. A press sends whatever text is selected
 * — empty included, which is how a press with no selection still stops speech.
 */
export function useTTS() {
  return {
    speak: (text: string): Promise<SpeakOutcome> => window.api.tts.toggle(text),
    stop: (): void => window.api.tts.stop(),
  }
}
